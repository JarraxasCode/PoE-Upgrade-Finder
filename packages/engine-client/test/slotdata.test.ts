import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolError } from '../src/check.ts';
import { readBaseTypes, readSlotData } from '../src/slotdata.ts';
import { sampleSlotDataJson } from './slotdata-sample.ts';

test('slot data: bases, shared pools, families and mods read; Lua empty arrays ({}) read as []', () => {
    const data = readSlotData(sampleSlotDataJson());
    assert.equal(data.baseType, 'Boots');
    assert.deepEqual(
        data.bases.map((b) => [b.name, b.tradeType, b.pools.none, b.pools.shaper]),
        [
            ['Sorcerer Boots', 'Sorcerer Boots', 0, 1],
            ['Slink Boots', 'Slink Boots', 2, 1],
            ['Two-Toned Boots (Armour/Evasion)', 'Two-Toned Boots', 2, undefined],
        ],
    );
    assert.deepEqual(data.bases[0]?.implicits, []);
    assert.equal(data.bases[1]?.subType, undefined);
    assert.deepEqual(data.bases[2]?.implicits[0]?.stats[0]?.range, [8, 12]);
    assert.deepEqual(data.bases[2]?.defences, { armour: [126, 145], evasion: [126, 145] });
    assert.deepEqual(data.bases[0]?.defences, { energyShield: [42, 51] });
    const hybrid = data.mods['ESSR1'];
    assert.deepEqual(
        hybrid?.stats.map((s) => [s.id, s.line, s.range]),
        [
            ['explicit.stat_2511217560', 1, [16, 17]],
            ['explicit.stat_4015621042', 0, [39, 42]],
        ],
    );
    assert.deepEqual([data.mods['AR1']?.stats[0]?.negate, data.mods['AR1']?.stats[0]?.range], [true, [-32, -32]]);
    assert.deepEqual(data.mods['ShaperMS']?.stats, []);
    assert.equal(data.unmatched.length, 1);
});

test('slot data: a missing line or range reads as undefined', () => {
    const json = sampleSlotDataJson();
    const mods = json['mods'] as Record<string, Record<string, unknown>>;
    mods['MS1'] = { ...mods['MS1'], stats: [{ id: 'explicit.stat_2250533757', text: 't', negate: false }] };
    const stat = readSlotData(json).mods['MS1']?.stats[0];
    assert.deepEqual([stat?.line, stat?.range], [undefined, undefined]);
});

test('slot data: dangling indices and mod ids, bad ranges and unknown influences are refused', () => {
    const broken = (edit: (json: Record<string, unknown>) => void): (() => unknown) => {
        const json = sampleSlotDataJson();
        edit(json);
        return () => readSlotData(json);
    };
    const mods = (json: Record<string, unknown>): Record<string, Record<string, unknown>> =>
        json['mods'] as Record<string, Record<string, unknown>>;
    assert.throws(
        broken((j) => {
            mods(j)['MS1'] = { ...mods(j)['MS1'], family: 9 };
        }),
        /slotData\.mods\.MS1\.family: expected an index below 6/,
    );
    assert.throws(
        broken((j) => {
            j['pools'] = [['NOPE']];
        }),
        /unknown mod NOPE/,
    );
    assert.throws(
        broken((j) => {
            (j['bases'] as Record<string, unknown>[])[0] = {
                name: 'x',
                tradeType: 'x',
                level: 1,
                tags: [],
                implicits: [],
                pools: { none: 7 },
            };
        }),
        ProtocolError,
    );
    assert.throws(
        broken((j) => {
            (j['bases'] as Record<string, unknown>[])[0] = {
                name: 'x',
                tradeType: 'x',
                level: 1,
                tags: [],
                implicits: [],
                pools: { none: 0, hunter: 1 },
            };
        }),
        /pools key/,
    );
    assert.throws(
        broken((j) => {
            mods(j)['MS1'] = { ...mods(j)['MS1'], stats: [{ id: 'a', text: 't', line: 0, negate: false, range: [5, 1] }] };
        }),
        /expected \[min, max\]/,
    );
    assert.throws(
        broken((j) => {
            mods(j)['MS1'] = { ...mods(j)['MS1'], stats: [{ id: 'a', text: 't', line: 3, negate: false }] };
        }),
        /line: expected an index below 1/,
    );
});

test('base types read', () => {
    assert.deepEqual(readBaseTypes({ types: [{ baseType: 'Boots', bases: 81 }] }).types, [{ baseType: 'Boots', bases: 81 }]);
    assert.deepEqual(readBaseTypes({ types: {} }).types, []);
});
