import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DEFAULT_FLOORS } from '@poe-upgrade-finder/core';
import { GEAR_SLOTS as ENGINE_SLOTS } from '@poe-upgrade-finder/engine-client';
import type { LoadBuildData, SocketGroupInfo } from '@poe-upgrade-finder/engine-client';
import { GEAR_SLOTS, readBuildSettings, readFloors, readLevelFilter } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { buildSummary, targetOptions } from '../src/services/build-summary.ts';
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

test('the ipc mirrors match core and the engine', () => {
    assert.deepEqual(GEAR_SLOTS, ENGINE_SLOTS);
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

    writeFileSync(join(dir, 'characters', buildSettingsFileName(id)), '{"blend": 9}');
    lines.length = 0;
    assert.deepEqual(store.buildSettings(id), defaultBuildSettings());
    assert.ok(lines.some((l) => l.includes('invalid')));
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
});
