import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_FLOORS } from '@poe-upgrade-finder/core';
import type { LoadBuildData, SocketGroupInfo } from '@poe-upgrade-finder/engine-client';
import { readBuildSettings, readFloors, readLevelFilter, readStoredBuildSettings } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { buildSummary, targetOptions, targetRequest } from '../src/services/build-summary.ts';
import { buildEntryFromHead, buildFilePath, listBuilds, resolveBuildsDir, xmlAttribute } from '../src/services/pob-builds.ts';
import { buildSettingsFileName, defaultBuildSettings, SettingsStore } from '../src/services/settings-store.ts';

const lines: string[] = [];
const log: Logger = {
    log(_level: string, message: string): void {
        lines.push(message);
    },
};

const root: string = mkdtempSync(join(tmpdir(), 'uf-services-'));
after(() => {
    rmSync(root, { recursive: true, force: true });
});

function save(path: string, head: string, mtimeSec: number): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n\t${head}\n</PathOfBuilding>\n`);
    utimesSync(path, mtimeSec, mtimeSec);
}

test('the defaults pass their own checks unchanged: the default floors (also read over by --floors) and build settings', () => {
    assert.deepEqual(readFloors(DEFAULT_FLOORS, 'f'), DEFAULT_FLOORS);
    assert.deepEqual(readBuildSettings(defaultBuildSettings(), 's'), defaultBuildSettings());
});

test('the level filter: older settings read as up to the character; levels are whole numbers 1 to 100 (issue #22)', () => {
    const { levelFilter: _none, ...older } = defaultBuildSettings();
    assert.deepEqual(readBuildSettings(older, 's').levelFilter, { kind: 'character' });
    assert.deepEqual(readLevelFilter({ kind: 'max', level: 90 }, 'l'), { kind: 'max', level: 90 });
    assert.deepEqual(readLevelFilter({ kind: 'off' }, 'l'), { kind: 'off' });
    for (const bad of [
        { kind: 'max' },
        { kind: 'max', level: 0 },
        { kind: 'max', level: 101 },
        { kind: 'max', level: 9.5 },
        { kind: 'off', level: 3 },
        { kind: 'all' },
    ]) {
        assert.throws(() => readLevelFilter(bad, 'l'), JSON.stringify(bad));
    }
});

test('xml attributes: first element, entities decoded', () => {
    assert.equal(xmlAttribute('<Misc a="1" buildPath="C:\\B &amp; C"/>', 'Misc', 'buildPath'), 'C:\\B & C');
    assert.equal(xmlAttribute('<Misc a="1"/>', 'Misc', 'buildPath'), undefined);
    assert.equal(xmlAttribute('<Miscellany buildPath="x"/>', 'Misc', 'buildPath'), undefined);
});

test('the Builds folder: override, then PoB Settings.xml, then the default', () => {
    const docs: string = join(root, 'docs1');
    assert.deepEqual(resolveBuildsDir(docs, null), { dir: join(docs, 'Path of Building', 'Builds'), source: 'pob-default' });
    mkdirSync(join(docs, 'Path of Building'), { recursive: true });
    writeFileSync(
        join(docs, 'Path of Building', 'Settings.xml'),
        `<PathOfBuilding><Misc buildSortMode="NAME" buildPath="${join(root, 'custom')}"/></PathOfBuilding>`,
    );
    assert.deepEqual(resolveBuildsDir(docs, null), { dir: join(root, 'custom'), source: 'pob-settings' });
    assert.deepEqual(resolveBuildsDir(docs, join(root, 'mine')), { dir: join(root, 'mine'), source: 'override' });
});

test('build entries from the save header; non-PoB XML is skipped', () => {
    const head: string = '<PathOfBuilding><Build ascendClassName="Chieftain" className="Marauder" level="94" targetVersion="3_0">';
    assert.deepEqual(buildEntryFromHead('Covens/Example RF.xml', head, 5), {
        id: 'Covens/Example RF.xml',
        name: 'Example RF',
        folder: 'Covens',
        className: 'Marauder',
        ascendClassName: 'Chieftain',
        level: 94,
        modifiedMs: 5,
    });
    assert.equal(buildEntryFromHead('x.xml', '<root/>', 0), undefined);
    assert.equal(buildEntryFromHead('x.xml', '<PathOfBuilding><Build ascendClassName="None" className="Witch">', 0)?.ascendClassName, null);
});

test('listing: sub-folders, newest first, junk left out; a missing folder says so', () => {
    const dir: string = join(root, 'builds');
    save(join(dir, 'Old.xml'), '<Build className="Witch" level="10">', 1_000);
    save(join(dir, 'League', 'New.xml'), '<Build className="Ranger" level="90">', 2_000);
    mkdirSync(join(dir, 'League'), { recursive: true });
    writeFileSync(join(dir, 'League', 'notes.txt'), 'x');
    writeFileSync(join(dir, 'other.xml'), '<settings/>');
    const list = listBuilds({ dir: dir, source: 'override' });
    assert.equal(list.error, null);
    assert.deepEqual(
        list.builds.map((b) => b.id),
        ['League/New.xml', 'Old.xml'],
    );
    const missing = listBuilds({ dir: join(root, 'nope'), source: 'pob-default' });
    assert.equal(missing.builds.length, 0);
    assert.match(missing.error ?? '', /wasn't found/);
});

test('build ids resolve only inside the folder', () => {
    const dir: string = join(root, 'builds');
    assert.equal(buildFilePath(dir, 'League/New.xml'), join(dir, 'League', 'New.xml'));
    assert.equal(buildFilePath(dir, '../secret.xml'), undefined);
    assert.equal(buildFilePath(dir, 'League/../../x.xml'), undefined);
    assert.equal(buildFilePath(dir, 'a.txt'), undefined);
});

test('settings: defaults, save and read back, broken files fall back', () => {
    const dir: string = join(root, 'appdata');
    const store: SettingsStore = new SettingsStore(dir, log);
    assert.equal(store.settings.league, 'Covens');
    assert.equal(store.settings.listing, 'securable');
    store.saveSettings({ ...store.settings, league: 'Standard', depth: 'quick' });
    assert.equal(new SettingsStore(dir, log).settings.league, 'Standard');

    const id: string = 'League/New.xml';
    assert.deepEqual(store.buildSettings(id), defaultBuildSettings());
    store.saveBuildSettings(id, { ...defaultBuildSettings(), lastSlot: 'Boots', blend: 0.7 });
    assert.equal(store.buildSettings(id).lastSlot, 'Boots');
    assert.equal(store.buildSettings(id).blend, 0.7);

    writeFileSync(join(dir, 'characters', buildSettingsFileName(id)), 'not json');
    lines.length = 0;
    assert.deepEqual(store.buildSettings(id), defaultBuildSettings());
    assert.ok(lines.some((l) => l.includes('invalid')));
});

test('a build settings file with bad parts keeps the rest, keeps the original and says so once (issue #69)', () => {
    const dir: string = join(root, 'appdata-69');
    const store: SettingsStore = new SettingsStore(dir, log);
    const notices: string[] = [];
    store.setNotifier((message: string) => {
        notices.push(message);
    });
    const id: string = 'League/RF.xml';
    const file: string = join(dir, 'characters', buildSettingsFileName(id));
    const goodPlan = { slot: 'Boots', itemType: null, base: null, picks: [] };
    const floors = { ...DEFAULT_FLOORS, chaosResMin: 20 };
    const original: string = JSON.stringify({
        ...defaultBuildSettings(),
        floors: floors,
        blend: 9, // out of range: back to the default alone
        lastSlot: 'Boots',
        slotPlans: { Boots: goodPlan, Gloves: { slot: 'Gloves', itemType: 5, base: null, picks: [] } },
        // Before #111: 0 was off (kept as off), other numbers absolute weights (dropped); a bad new edit drops its slot.
        weightEdits: {
            Boots: { 'explicit.stat_1': 0, 'explicit.stat_3': { factor: 2 }, 'explicit.stat_4': 2.5 },
            Gloves: { 'explicit.stat_2': { factor: -1 } },
        },
        fromANewerVersion: true,
    });
    mkdirSync(join(dir, 'characters'), { recursive: true });
    writeFileSync(file, original);

    const read = store.buildSettings(id);
    assert.deepEqual(read.floors, floors);
    assert.equal(read.lastSlot, 'Boots');
    assert.equal(read.blend, defaultBuildSettings().blend);
    assert.deepEqual(read.slotPlans, { Boots: goodPlan });
    assert.deepEqual(read.weightEdits, { Boots: { 'explicit.stat_1': { off: true }, 'explicit.stat_3': { factor: 2 } } });

    const copies: string[] = readdirSync(join(dir, 'characters')).filter((n: string) => n.includes('.bad-'));
    assert.equal(copies.length, 1);
    assert.equal(readFileSync(join(dir, 'characters', copies[0] ?? ''), 'utf8'), original);
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? '', /RF\.xml.*5 settings.*\.bad-/);

    // The file now holds the repaired settings: reading again repairs nothing and says nothing.
    assert.deepEqual(store.buildSettings(id), read);
    assert.equal(notices.length, 1);
    assert.equal(readdirSync(join(dir, 'characters')).filter((n: string) => n.includes('.bad-')).length, 1);
});

test('repair notices from before the window wait for the notifier (issue #69)', () => {
    const dir: string = join(root, 'appdata-69-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{"league": ""}');
    const store: SettingsStore = new SettingsStore(dir, log);
    assert.equal(store.settings.league, 'Covens');
    const notices: string[] = [];
    store.setNotifier((message: string) => {
        notices.push(message);
    });
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? '', /app settings.*\.bad-/);
    assert.ok(readdirSync(dir).some((n: string) => n.startsWith('settings.bad-')));
});

test('stored build settings: a value that is not a record is refused whole; each bad field is reported', () => {
    assert.throws(() => readStoredBuildSettings([], 's', defaultBuildSettings(), () => undefined));
    const dropped: string[] = [];
    const read = readStoredBuildSettings(
        { ...defaultBuildSettings(), minGainPct: 'x', slotPlans: 3 },
        's',
        defaultBuildSettings(),
        (p: string) => {
            dropped.push(p);
        },
    );
    assert.deepEqual(read, defaultBuildSettings());
    assert.equal(dropped.length, 2);
    assert.ok(dropped.some((p: string) => p.startsWith('s.minGainPct')));
});

test('settings file names: readable, distinct per folder', () => {
    const a: string = buildSettingsFileName('A/RF.xml');
    const b: string = buildSettingsFileName('B/RF.xml');
    assert.match(a, /^RF-[0-9a-f]{10}\.json$/);
    assert.notEqual(a, b);
    assert.match(buildSettingsFileName('x/<bad>:name?.xml'), /^_bad_name_-/);
});

function group(
    index: number,
    name: string,
    skills: { name: string; parts?: string[]; minion?: string }[],
    extra: Partial<SocketGroupInfo> = {},
): SocketGroupInfo {
    return {
        index: index,
        name: name,
        enabled: true,
        slot: undefined,
        includeInFullDPS: false,
        mainActiveSkill: 1,
        activeSkills: skills.map((s, i) => ({ index: i + 1, name: s.name, minion: s.minion, parts: s.parts ?? [], skillPart: undefined })),
        ...extra,
    };
}

test('target ids as engine requests (moved from the retired CLI)', () => {
    assert.deepEqual(targetRequest('saved'), { kind: 'saved' });
    assert.deepEqual(targetRequest('full'), { kind: 'fullDps' });
    assert.deepEqual(targetRequest('skill:8.1.2'), { kind: 'skill', group: 8, activeSkill: 1, part: 2 });
    assert.deepEqual(targetRequest('skill:5.1'), { kind: 'skill', group: 5, activeSkill: 1 });
    assert.throws(() => targetRequest('skill:5'), /bad damage target/);
});

test('damage targets: saved, Full DPS with the ticked groups, each skill and part', () => {
    const skills: SocketGroupInfo[] = [
        group(1, '', [{ name: 'Righteous Fire' }], { includeInFullDPS: true }),
        group(2, '', [{ name: 'Fire Trap', parts: ['Hit', 'Burning ground'] }], { includeInFullDPS: true }),
        group(3, '', [{ name: 'Summon Raging Spirit', minion: 'Raging Spirit' }]),
        group(4, '', [{ name: 'Herald of Ash' }], { enabled: false }),
        group(5, '', [{ name: 'Righteous Fire' }], { slot: 'Helmet' }),
    ];
    const options = targetOptions(skills, {
        kind: 'skill',
        saved: true,
        group: 1,
        activeSkill: 1,
        part: undefined,
        name: 'Righteous Fire',
    });
    assert.deepEqual(options, [
        { id: 'saved', label: 'As saved in PoB: Righteous Fire' },
        { id: 'full', label: 'Full DPS: Righteous Fire + Fire Trap' },
        { id: 'skill:1.1', label: 'Righteous Fire (group 1)' },
        { id: 'skill:2.1.1', label: 'Fire Trap: Hit' },
        { id: 'skill:2.1.2', label: 'Fire Trap: Burning ground' },
        { id: 'skill:3.1', label: 'Summon Raging Spirit (Raging Spirit)' },
        { id: 'skill:5.1', label: 'Righteous Fire (Helmet)' },
    ]);
});

test('the summary warns when the damage target reads 0', () => {
    const load: LoadBuildData = {
        buildId: 'b',
        pobVersion: '2.67.2',
        info: { className: 'Witch', ascendClassName: 'None', level: 90, treeVersion: '3_30', mainSocketGroup: 1 },
        skills: [],
        target: { kind: 'fullDps', saved: true },
        baseline: { damage: 0, values: { TotalEHP: 50_000, Life: 4_000 }, skillDps: undefined },
        equipped: [],
    };
    const s = buildSummary({
        buildId: 'x.xml',
        load: load,
        targetId: 'saved',
        target: load.target,
        stats: load.baseline,
        warnings: [{ code: 'w', message: 'from PoB' }],
        fileModifiedMs: 1,
        art: () => undefined,
    });
    assert.equal(s.ascendClassName, null);
    assert.equal(s.ehp, 50_000);
    assert.equal(s.targetLabel, 'Full DPS');
    assert.equal(s.warnings[0], 'from PoB');
    assert.match(s.warnings[1] ?? '', /reads 0/);
    // PoB's own reason for a 0 (#36) replaces the generic hint.
    const disabled = buildSummary({
        buildId: 'x.xml',
        load: load,
        targetId: 'saved',
        target: load.target,
        stats: load.baseline,
        warnings: [{ code: 'target-disabled', message: 'The damage target reads 0: PoB has disabled X (No usable weapon equipped).' }],
        fileModifiedMs: 1,
        art: () => undefined,
    });
    assert.deepEqual(disabled.warnings, ['The damage target reads 0: PoB has disabled X (No usable weapon equipped).']);
});

test('stored build settings: a v0.2 file has no unique choices, and reads with none and no drop (#113)', () => {
    const { uniqueChoices: _none, ...v02 } = defaultBuildSettings();
    const dropped: string[] = [];
    const read = readStoredBuildSettings(v02, 's', defaultBuildSettings(), (p: string) => {
        dropped.push(p);
    });
    assert.deepEqual(read.uniqueChoices, {});
    assert.deepEqual(dropped, []);
});

test('stored build settings: a unique choice round-trips, apostrophe and all, beside the rare plan', () => {
    const plan = { slot: 'Boots', itemType: 'Boots', base: 'Sorcerer Boots', picks: [] } as const;
    const settings = {
        ...defaultBuildSettings(),
        slotPlans: { Boots: plan },
        uniqueChoices: { Boots: { mode: 'unique', unique: { name: "Kaom's Roots", base: 'Titan Greaves', tradeType: 'Titan Greaves' } } },
    };
    const back = readBuildSettings(JSON.parse(JSON.stringify(settings)), 's');
    assert.deepEqual(back.uniqueChoices, settings.uniqueChoices);
    assert.deepEqual(back.slotPlans, settings.slotPlans);
    assert.throws(() => readBuildSettings({ ...settings, uniqueChoices: { Boots: { mode: 'legendary', unique: null } } }, 's'));
});

test('settings: Normal search depth on first start; a saved Thorough stays (#59)', () => {
    const dir: string = join(root, 'appdata-depth');
    const store: SettingsStore = new SettingsStore(dir, log);
    assert.equal(store.settings.depth, 'normal');
    store.saveSettings({ ...store.settings, depth: 'thorough' });
    assert.equal(new SettingsStore(dir, log).settings.depth, 'thorough');
});
