import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTradeQuery } from '@poe-upgrade-finder/engine-client';
import type { TradeQueryData } from '@poe-upgrade-finder/engine-client';
import { CacheDb, generatorKey } from '../src/services/cache-db.ts';

function sampleQuery(): TradeQueryData {
    return readTradeQuery({
        slot: 'Boots', target: { kind: 'fullDps', saved: true }, item: { name: 'n', base: 'b', rarity: 'RARE' },
        category: { query: 'armour.boots', generator: 'Boots' }, statWeights: [{ stat: 'FullDPS', weight: 0.5 }],
        baseStatValue: 0, weights: [{ id: 'explicit.stat_1', weight: 2, meanStatDiff: 40, invert: false }],
        query: { stats: [{ type: 'weight', filters: [{ id: 'explicit.stat_1', value: { weight: 2 } }] }], filters: { x: 1 } },
        calcs: 147, seconds: 0.7, log: [],
    });
}

test('cache file: rates and generator results survive a reopen; reads are checked', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-cache-'));
    const file: string = join(dir, 'cache.sqlite');
    try {
        const key: string = generatorKey({ xmlHash: 'abc', slot: 'Boots', target: { kind: 'saved' }, blend: 0.5, pobVersion: '2.67.2' });
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
    const base = { xmlHash: 'abc', slot: 'Boots', target: { kind: 'saved' } as const, blend: 0.5, pobVersion: '2.67.2' };
    const k: string = generatorKey(base);
    assert.equal(generatorKey({ ...base }), k);
    for (const changed of [{ xmlHash: 'abd' }, { slot: 'Gloves' }, { target: { kind: 'fullDps' } as const }, { blend: 0.6 }, { pobVersion: '2.68.0' }]) {
        assert.notEqual(generatorKey({ ...base, ...changed }), k);
    }
});

test('cache file: the last gear per build survives a reopen', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-cache-'));
    const file: string = join(dir, 'cache.sqlite');
    try {
        const db: CacheDb = new CacheDb(file);
        assert.equal(db.equipped('a.xml'), undefined);
        db.saveEquipped('a.xml', [{ slot: 'Boots', name: 'X', base: 'Leviathan Greaves', rarity: 'RARE', view: null }]);
        db.close();
        const again: CacheDb = new CacheDb(file);
        assert.deepEqual(again.equipped('a.xml'), [{ slot: 'Boots', name: 'X', base: 'Leviathan Greaves', rarity: 'RARE', view: null }]);
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
