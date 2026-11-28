import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSlotData, readTradeQuery } from '@poe-upgrade-finder/engine-client';
import type { SlotData, TradeQueryData, UniquesData } from '@poe-upgrade-finder/engine-client';
import { sampleSlotDataJson } from '../../../packages/engine-client/test/slotdata-sample.ts';
import type { BuildSummary } from '@poe-upgrade-finder/ipc';
import { CacheDb, generatorKey, summaryKey, uniquesKey } from '../src/services/cache-db.ts';

function sampleQuery(): TradeQueryData {
    return readTradeQuery({
        slot: 'Boots',
        target: { kind: 'fullDps', saved: true },
        item: { name: 'n', base: 'b', rarity: 'RARE' },
        category: { query: 'armour.boots', generator: 'Boots' },
        statWeights: [{ stat: 'FullDPS', weight: 0.5 }],
        baseStatValue: 0,
        weights: [{ id: 'explicit.stat_1', weight: 2, meanStatDiff: 40, invert: false }],
        query: { stats: [{ type: 'weight', filters: [{ id: 'explicit.stat_1', value: { weight: 2 } }] }], filters: { x: 1 } },
        calcs: 147,
        seconds: 0.7,
        log: [],
    });
}

test('cache file: rates and generator results survive a reopen; reads are checked', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-cache-'));
    const file: string = join(dir, 'cache.sqlite');
    try {
        const key: string = generatorKey({
            xmlHash: 'abc',
            slot: 'Boots',
            target: { kind: 'saved' },
            blend: 0.5,
            pobVersion: '2.67.2',
            source: 'pob',
        });
        const db: CacheDb = new CacheDb(file);
        db.rateStore().set('Covens', { chaosPerDivine: 216.8, source: 'ggg', hour: 1_795_000_000, at: 1 });
        db.saveGenerator(key, sampleQuery());
        db.close();

        const again: CacheDb = new CacheDb(file);
        assert.deepEqual(again.rateStore().get('Covens'), { chaosPerDivine: 216.8, source: 'ggg', hour: 1_795_000_000, at: 1 });
        assert.equal(again.rateStore().get('Standard'), undefined);
        const q: TradeQueryData | undefined = again.generator(key);
        assert.ok(q !== undefined);
        assert.deepEqual(q, sampleQuery());
        assert.equal(again.generator('other'), undefined);
        assert.equal(again.clearGenerator(), 1);
        assert.equal(again.generator(key), undefined);
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('generator keys change with the build, slot, target, blend and PoB version', () => {
    const base = {
        xmlHash: 'abc',
        slot: 'Boots',
        target: { kind: 'saved' } as const,
        blend: 0.5,
        pobVersion: '2.67.2',
        source: 'pob',
    } as const;
    const k: string = generatorKey(base);
    // PoB's keys hash without a source, as before the key had one (v0.2). GENERATOR_DATA 3 (#109) drops the rows
    // cached before it: this key was 71ced8e5… with GENERATOR_DATA 2.
    assert.equal(k, 'a5d9855ba3943d29066fef44ba01586d8fbd624bd248da9e0bfcbdd82968ef9d');
    assert.equal(generatorKey({ ...base }), k);
    for (const changed of [
        { xmlHash: 'abd' },
        { slot: 'Gloves' },
        { target: { kind: 'fullDps' } as const },
        { blend: 0.6 },
        { pobVersion: '2.68.0' },
    ]) {
        assert.notEqual(generatorKey({ ...base, ...changed }), k);
    }
});

test('cache file: the last gear per build survives a reopen', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-cache-'));
    const file: string = join(dir, 'cache.sqlite');
    try {
        const db: CacheDb = new CacheDb(file);
        assert.equal(db.equipped('a.xml'), undefined);
        db.saveEquipped('a.xml', [{ slot: 'Boots', name: 'X', base: 'Leviathan Greaves', rarity: 'RARE', itemType: 'Boots', view: null }]);
        db.close();
        const again: CacheDb = new CacheDb(file);
        assert.deepEqual(again.equipped('a.xml'), [
            { slot: 'Boots', name: 'X', base: 'Leviathan Greaves', rarity: 'RARE', itemType: 'Boots', view: null },
        ]);
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('slot data: cached per PoB version and base type; a new PoB version replaces old rows', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-cache-'));
    const file: string = join(dir, 'cache.sqlite');
    try {
        const boots: SlotData = readSlotData(sampleSlotDataJson());
        const db: CacheDb = new CacheDb(file);
        assert.equal(db.slotData('2.68.1', 'Boots'), undefined);
        db.saveSlotData(boots);
        db.close();

        const again: CacheDb = new CacheDb(file);
        assert.deepEqual(again.slotData('2.68.1', 'Boots'), boots);
        assert.equal(again.slotData('2.68.1', 'Ring'), undefined);
        assert.equal(again.slotData('2.69.0', 'Boots'), undefined);
        again.saveSlotData({ ...boots, pobVersion: '2.69.0' });
        assert.equal(again.slotData('2.68.1', 'Boots'), undefined, 'the old version was dropped');
        assert.equal(again.slotData('2.69.0', 'Boots')?.pobVersion, '2.69.0');
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('build summary: kept per save hash, target, PoB and app version; any change is a miss', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-cache-'));
    const file: string = join(dir, 'cache.sqlite');
    const summary: BuildSummary = {
        buildId: 'a.xml',
        pobVersion: '2.68.1',
        className: 'Marauder',
        ascendClassName: 'Chieftain',
        level: 95,
        targetId: 'saved',
        targetLabel: 'Full DPS',
        targets: [{ id: 'saved', label: 'As saved in PoB: Full DPS' }],
        damage: 3873633.2,
        ehp: 94200,
        life: 6302,
        equipped: [],
        warnings: [],
        fileModifiedMs: 1,
    };
    const base = { xmlHash: 'h1', targetId: 'saved', pobVersion: '2.68.1', appVersion: '0.2.0' } as const;
    try {
        const db: CacheDb = new CacheDb(file);
        db.saveBuildSummary(summaryKey(base), summary);
        db.close();
        const again: CacheDb = new CacheDb(file);
        assert.deepEqual(again.buildSummary(summaryKey(base)), summary);
        for (const changed of [
            { ...base, xmlHash: 'h2' },
            { ...base, targetId: 'full' },
            { ...base, pobVersion: '2.69.0' },
            { ...base, appVersion: '0.2.1' },
        ]) {
            assert.equal(again.buildSummary(summaryKey(changed)), undefined);
        }
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const UNIQUES: UniquesData = {
    slot: 'Boots',
    itemType: 'Boots',
    target: { kind: 'fullDps', saved: true },
    uniques: [
        {
            name: "Kaom's Roots",
            base: 'Titan Greaves',
            tradeType: 'Titan Greaves',
            variant: 2,
            variants: 2,
            scoreLow: 1405,
            scoreMid: 1413,
            scoreHigh: 1422,
            change: -78,
            weights: [{ id: 'explicit.stat_3299347043', weight: 0.33, line: '+(150-200) to maximum Life' }],
            rolls: [],
            statIds: ['explicit.stat_3299347043'],
            unmatched: [],
        },
    ],
};

test('uniques: cached per key, survive a reopen, and go with the generator rows', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-cache-'));
    const file: string = join(dir, 'cache.sqlite');
    try {
        const key: string = uniquesKey({
            xmlHash: 'abc',
            slot: 'Boots',
            itemType: 'Boots',
            target: { kind: 'saved' },
            blend: 0.5,
            pobVersion: '2.68.1',
        });
        assert.notEqual(
            key,
            uniquesKey({ xmlHash: 'abc', slot: 'Boots', itemType: 'Boots', target: { kind: 'saved' }, blend: 0.6, pobVersion: '2.68.1' }),
        );
        assert.notEqual(
            key,
            uniquesKey({ xmlHash: 'abc', slot: 'Ring 1', itemType: 'Boots', target: { kind: 'saved' }, blend: 0.5, pobVersion: '2.68.1' }),
        );
        const db: CacheDb = new CacheDb(file);
        db.saveUniques(key, UNIQUES);
        db.close();
        const again: CacheDb = new CacheDb(file);
        assert.deepEqual(again.uniques(key), UNIQUES);
        assert.equal(again.uniques('other'), undefined);
        again.clearGenerator();
        assert.equal(again.uniques(key), undefined);
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
