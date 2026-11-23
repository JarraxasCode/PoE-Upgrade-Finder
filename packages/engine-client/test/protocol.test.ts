import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProtocolError } from '../src/check.ts';
import { parseMessage, readScoreItem, readStatBlock, readTradeQuery } from '../src/protocol.ts';

test('parses the four message kinds', () => {
    assert.deepEqual(parseMessage('{"event":"ready","data":{"pobVersion":"2.68.1","gcEvery":100}}'), {
        type: 'ready',
        pobVersion: '2.68.1',
        gcEvery: 100,
    });
    assert.equal(parseMessage('{"event":"fatal","error":{"code":"pob-startup","message":"x"}}').type, 'fatal');
    assert.deepEqual(parseMessage('{"id":3,"event":"progress","data":{"calcs":25}}'), {
        type: 'stream',
        id: 3,
        event: 'progress',
        data: { calcs: 25 },
    });
    const final = parseMessage('{"id":3,"ok":false,"error":{"code":"bad-slot","message":"no slot"},"warnings":{}}');
    assert.ok(final.type === 'final');
    assert.deepEqual(final.error, { code: 'bad-slot', message: 'no slot' });
    assert.deepEqual(final.warnings, []);
});

test('bad messages name the bad field', () => {
    assert.throws(() => parseMessage('nope'), ProtocolError);
    assert.throws(() => parseMessage('{"id":"x","ok":true}'), /message\.id: expected a number/);
    assert.throws(() => parseMessage('{"id":1,"event":"other","data":{}}'), /message\.event: expected one of progress, item/);
    assert.throws(() => parseMessage('{"id":1,"ok":false,"warnings":[]}'), /message\.error/);
});

test('stat blocks decode non-finite numbers and reject strings', () => {
    const block = readStatBlock({ damage: 'NaN', values: { TotalEHP: '-Infinity', MaimImmunity: true } }, 'b');
    assert.ok(Number.isNaN(block.damage));
    assert.equal(block.values['TotalEHP'], Number.NEGATIVE_INFINITY);
    assert.equal(block.skillDps, undefined);
    assert.throws(() => readStatBlock({ damage: 1, values: { ReqStrString: '^7 120' } }, 'b'), /b\.values\.ReqStrString/);
});

test('score items: success and failure shapes', () => {
    const ok = readScoreItem({
        index: 0,
        ok: true,
        item: { name: 'n', base: 'b', rarity: 'RARE' },
        stats: { damage: 1, values: {} },
        unparsed: {},
        validForSlot: false,
    });
    assert.ok(ok.ok);
    assert.deepEqual(ok.unparsed, []);
    const bad = readScoreItem({ index: 2, ok: false, error: { code: 'parse-failed', message: 'm' } });
    assert.ok(!bad.ok);
    assert.equal(bad.error.code, 'parse-failed');
});

test('trade query keeps the typed stat groups and the raw query', () => {
    const q = readTradeQuery({
        slot: 'Boots',
        target: { kind: 'fullDps', saved: true },
        item: { name: 'n', base: 'b', rarity: 'RARE' },
        category: { query: 'armour.boots', generator: 'Boots' },
        statWeights: [{ stat: 'FullDPS', weight: 0.5 }],
        baseStatValue: 0,
        weights: [{ id: 'explicit.stat_1', weight: 2, meanStatDiff: 40, invert: false }],
        query: {
            stats: [
                { type: 'weight', filters: [{ id: 'explicit.stat_1', value: { weight: 2 } }] },
                { type: 'and', filters: {} },
            ],
            filters: { x: 1 },
        },
        calcs: 147,
        seconds: 0.7,
        log: ['filters: 1, budget: 47'],
    });
    assert.equal(q.query.stats[0]?.filters[0]?.weight, 2);
    assert.deepEqual(q.query.stats[1]?.filters, []);
    assert.deepEqual(q.query.raw['filters'], { x: 1 });
    assert.equal(q.queryError, undefined);
});

test('trade query weights may be non-finite (the engine sends them as strings)', () => {
    const q = readTradeQuery({
        slot: 'Boots',
        target: { kind: 'fullDps', saved: true },
        item: { name: 'n', base: 'b', rarity: 'RARE' },
        category: { query: 'armour.boots', generator: 'Boots' },
        statWeights: [{ stat: 'FullDPS', weight: 0.5 }],
        baseStatValue: 0,
        weights: [{ id: 'explicit.stat_1', weight: 'Infinity', meanStatDiff: 'NaN', invert: false }],
        query: { stats: [{ type: 'weight', filters: [{ id: 'explicit.stat_1', value: { weight: 'Infinity' } }] }] },
        calcs: 147,
        seconds: 0.7,
        log: [],
    });
    assert.equal(q.weights[0]?.weight, Infinity);
    assert.ok(Number.isNaN(q.weights[0]?.meanStatDiff));
    assert.equal(q.query.stats[0]?.filters[0]?.weight, Infinity);
});
