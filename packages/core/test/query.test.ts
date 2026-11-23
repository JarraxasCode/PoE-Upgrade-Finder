import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BandSearch } from '../src/bands.ts';
import { priceBands } from '../src/bands.ts';
import { DEFAULT_FLOORS } from '../src/floors.ts';
import { compileQuery, predictComplexity, QueryCompileError } from '../src/query-compiler.ts';
import type { CompiledQuery } from '../src/query-compiler.ts';
import { maxLevelRequirement, saveSpec } from '../src/spec.ts';
import type { PobTradeQuery, RunContext, SearchRequirement, SlotSearchSpec, WeightedStat } from '../src/spec.ts';
import { v1SpecBuilder } from '../src/v1.ts';
import { baseStats } from './fixtures.ts';

function pobQuery(weights: number): PobTradeQuery {
    const filters: { id: string; weight: number | undefined }[] = [];
    for (let i: number = 0; i < weights; i++) {
        filters.push({ id: `explicit.stat_${1000 + i}`, weight: 3 - i * 0.05 });
    }
    return {
        category: { query: 'armour.boots' },
        query: {
            stats: [
                { type: 'weight', filters: filters },
                { type: 'not', filters: [] },
            ],
        },
    };
}

function context(weights: number, stripped = baseStats()): RunContext {
    return {
        slot: 'Boots',
        listingType: 'securable',
        priceBands: priceBands(300),
        characterLevel: 94,
        baseline: baseStats(),
        stripped: stripped,
        pobQuery: pobQuery(weights),
        floors: DEFAULT_FLOORS,
    };
}

function requirements(n: number): SearchRequirement[] {
    const out: SearchRequirement[] = [];
    for (let i: number = 0; i < n; i++) {
        out.push({ statId: `pseudo.r${i}`, min: 10 + i, origin: 'strip', label: `r${i}` });
    }
    return out;
}

const SEARCH: BandSearch = { bandId: 'band-2', option: 'chaos', price: { min: 1, max: 33.33, option: 'chaos' } };

test('the V8 formula matches the live checks (boots 22 + 5 = 154, helmet/amulet 32 + 5 = 194, edge 33 + 5 = 198, 34 + 5 = 202)', () => {
    assert.equal(predictComplexity(22, 5), 154);
    assert.equal(predictComplexity(32, 5), 194);
    assert.equal(predictComplexity(33, 5), 198);
    assert.equal(predictComplexity(34, 5), 202);
    assert.equal(predictComplexity(35, 0), 200);
});

test('the v1 spec takes PoB weights in order, strip needs, floors and the category', () => {
    const spec: SlotSearchSpec = v1SpecBuilder().build(context(3, baseStats({ ChaosResist: 31, ChaosResistTotal: 31 })));
    assert.equal(spec.category, 'armour.boots');
    assert.equal(spec.weightGroupType, 'weight');
    assert.deepEqual(
        spec.weights.map((w: WeightedStat) => w.statId),
        ['explicit.stat_1000', 'explicit.stat_1001', 'explicit.stat_1002'],
    );
    assert.deepEqual(
        spec.requirements.map((r: SearchRequirement) => [r.statId, r.min]),
        [['pseudo.pseudo_total_chaos_resistance', 19]],
    );
    assert.equal(spec.checks.length, 16);
    assert.deepEqual(spec.noters, []);
    const saved = saveSpec(spec);
    assert.equal(JSON.parse(JSON.stringify(saved)).checks[0].id, 'chaos-res');
});

test('compiles the merged query: weighted group first, And group, our filters, no min, sorted by the weighted sum', () => {
    const spec: SlotSearchSpec = { ...v1SpecBuilder().build(context(2)), requirements: requirements(2) };
    const q: CompiledQuery = compileQuery(spec, SEARCH);
    assert.deepEqual(q.body, {
        query: {
            status: { option: 'securable' },
            stats: [
                {
                    type: 'weight',
                    filters: [
                        { id: 'explicit.stat_1000', value: { weight: 3 } },
                        { id: 'explicit.stat_1001', value: { weight: 2.95 } },
                    ],
                },
                {
                    type: 'and',
                    filters: [
                        { id: 'pseudo.r0', value: { min: 10 } },
                        { id: 'pseudo.r1', value: { min: 11 } },
                    ],
                },
            ],
            filters: {
                type_filters: { filters: { category: { option: 'armour.boots' }, rarity: { option: 'nonunique' } } },
                req_filters: { filters: { lvl: { max: 94 } } },
                trade_filters: { filters: { price: { min: 1, max: 33.33, option: 'chaos' } } },
            },
        },
        sort: { 'statgroup.0': 'desc' },
    });
    assert.equal(q.complexity, predictComplexity(2, 2));
    assert.deepEqual(q.dropped, []);
});

test('over budget, the lowest-priority weights are dropped and the requirements kept', () => {
    const spec: SlotSearchSpec = { ...v1SpecBuilder().build(context(40)), requirements: requirements(5) };
    const q: CompiledQuery = compileQuery(spec, SEARCH);
    assert.equal(q.weightsUsed, 33);
    assert.equal(q.complexity, 198);
    assert.equal(q.dropped.length, 7);
    assert.equal(q.dropped[0]?.statId, 'explicit.stat_1033');
    assert.equal(q.body.query.stats[1]?.filters.length, 5);
});

test('over budget, a weight boosted in the review is kept and the smallest weights are dropped instead', () => {
    const built: SlotSearchSpec = v1SpecBuilder().build({ ...context(40), weightEdits: { 'explicit.stat_1038': 5 } });
    const spec: SlotSearchSpec = { ...built, requirements: requirements(5) };
    const q: CompiledQuery = compileQuery(spec, SEARCH);
    const kept: readonly string[] = q.body.query.stats[0]?.filters.map((f: { readonly id: string }) => f.id) ?? [];
    assert.equal(kept.length, 33);
    assert.ok(kept.includes('explicit.stat_1038'));
    // The kept stats keep PoB's order.
    assert.equal(kept.at(-1), 'explicit.stat_1038');
    assert.equal(kept.at(-2), 'explicit.stat_1031');
    assert.deepEqual(
        q.dropped.map((w: WeightedStat) => w.statId),
        [
            'explicit.stat_1032',
            'explicit.stat_1033',
            'explicit.stat_1034',
            'explicit.stat_1035',
            'explicit.stat_1036',
            'explicit.stat_1037',
            'explicit.stat_1039',
        ],
    );
});

test('no weights: no weighted group, cheapest first; too many requirements is an error', () => {
    const spec: SlotSearchSpec = { ...v1SpecBuilder().build(context(0)), requirements: requirements(1) };
    const q: CompiledQuery = compileQuery(spec, SEARCH);
    assert.deepEqual(q.body.sort, { price: 'asc' });
    assert.equal(q.body.query.stats[0]?.type, 'and');
    assert.throws(() => compileQuery({ ...spec, requirements: requirements(200) }, SEARCH), QueryCompileError);
});

test('the level filter: up to the character (default), a set level, or none (issue #22)', () => {
    const levelOf = (spec: SlotSearchSpec): unknown => compileQuery(spec, SEARCH).body.query.filters.req_filters;
    const ctx: RunContext = context(3);
    assert.equal(maxLevelRequirement(94), 94);
    assert.equal(maxLevelRequirement(undefined, { kind: 'character' }), undefined);
    assert.equal(maxLevelRequirement(94, { kind: 'max', level: 100 }), 100);
    assert.equal(maxLevelRequirement(94, { kind: 'off' }), undefined);
    assert.deepEqual(levelOf(v1SpecBuilder().build(ctx)), { filters: { lvl: { max: 94 } } });
    assert.deepEqual(levelOf(v1SpecBuilder().build({ ...ctx, levelFilter: { kind: 'max', level: 90 } })), {
        filters: { lvl: { max: 90 } },
    });
    const off: SlotSearchSpec = v1SpecBuilder().build({ ...ctx, levelFilter: { kind: 'off' } });
    assert.equal(levelOf(off), undefined);
    assert.equal(saveSpec(off).maxLevelRequirement, undefined);
});
