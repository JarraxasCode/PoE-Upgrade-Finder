// The site's pseudo totals: the table (V27) and totals as their own slot plan picks (issue #26).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlotData, SlotModType } from '@poe-upgrade-finder/engine-client';
import type { BandSearch } from '../src/bands.ts';
import { checkPlan, pruneWeights } from '../src/plan.ts';
import type { ModPick, PlanTotal, SlotPlan } from '../src/plan.ts';
import { PSEUDO_TOTALS, pseudoSourceStats, pseudoTotalFor } from '../src/pseudo-totals.ts';
import { compileQuery, requirementFilters } from '../src/query-compiler.ts';
import { buildSlotSpec } from '../src/slot-spec.ts';
import type { PrunedWeight, SearchRequirement, SlotSearchSpec, WeightedStat } from '../src/spec.ts';
import { bootsContext, bootsData } from './plan-fixtures.ts';

const R = {
    dex: 'explicit.stat_3261801346',
    str: 'explicit.stat_4080418644',
    allAttr: 'explicit.stat_1379411836',
    life: 'explicit.stat_3299347043',
    fire: 'explicit.stat_3372524247',
    cold: 'explicit.stat_4220027924',
    chaos: 'explicit.stat_2923486259',
} as const;

const PSEUDO = {
    dex: 'pseudo.pseudo_total_dexterity',
    life: 'pseudo.pseudo_total_life',
    fire: 'pseudo.pseudo_total_fire_resistance',
    chaos: 'pseudo.pseudo_total_chaos_resistance',
} as const;

const SEARCH: BandSearch = { bandId: 'band-2', option: 'chaos', price: { min: 1, max: 33.33, option: 'chaos' } };

/** The boots fixture plus families with real trade ids, all on Sorcerer Boots. */
function data(): SlotData {
    const d: SlotData = bootsData();
    const extra: readonly (readonly [string, SlotModType, string, string, readonly [number, number]])[] = [
        ['RDEX', 'Suffix', 'Dexterity', R.dex, [8, 55]],
        ['RSTR', 'Suffix', 'Strength', R.str, [8, 55]],
        ['RALL', 'Suffix', 'AllAttributes', R.allAttr, [1, 16]],
        ['RLIFE', 'Prefix', 'RealLife', R.life, [3, 99]],
        ['RFIRE', 'Suffix', 'RealFire', R.fire, [6, 48]],
        ['RCOLD', 'Suffix', 'RealCold', R.cold, [6, 48]],
        ['RCHAOS', 'Suffix', 'RealChaos', R.chaos, [5, 35]],
    ];
    const families = [...d.families];
    const mods = { ...d.mods };
    const pool: string[] = [...(d.pools[0] ?? [])];
    for (const [name, type, group, id, range] of extra) {
        const modId: string = `${name}1`;
        mods[modId] = {
            type: type,
            family: families.length,
            level: 1,
            lines: [id],
            via: 'hash',
            stats: [{ id: id, text: id, line: 0, negate: false, range: range }],
        };
        families.push({ type: type, group: group, source: 'natural', text: id, tradeIds: [id], siteTexts: [id], tiers: [modId] });
        pool.push(modId);
    }
    return { ...d, families: families, mods: mods, pools: [pool, ...d.pools.slice(1)] };
}

function include(position: ModPick['position'], group: string, statId: string, extra: { min?: number } = {}): ModPick {
    return { position: position, group: group, influence: 'none', rule: 'include', stats: [{ statId: statId, ...extra }] };
}

function plan(picks: readonly ModPick[], totals: readonly PlanTotal[] = []): SlotPlan {
    return { slot: 'Boots', itemType: 'Boots', base: 'Sorcerer Boots', picks: picks, ...(totals.length === 0 ? {} : { totals: totals }) };
}

function specOf(p: SlotPlan, weights: readonly (readonly [string, number])[] = []): SlotSearchSpec {
    const result = buildSlotSpec(p, { context: bootsContext(weights), slotData: data() });
    if (!result.ok) {
        assert.fail(result.check.problems.map((x) => x.text).join('; '));
    }
    return result.spec;
}

function prunedOf(p: SlotPlan, ids: readonly string[]): ReadonlyMap<string, PrunedWeight['reason']> {
    const weights: WeightedStat[] = ids.map((id: string) => ({ statId: id, weight: 1 }));
    return new Map(pruneWeights(weights, p, 'Boots', data()).pruned.map((w: PrunedWeight) => [w.statId, w.reason]));
}

test('the table: each stat maps to one pseudo, and every pseudo counts its own stat', () => {
    const seen: Set<string> = new Set<string>();
    for (const p of PSEUDO_TOTALS) {
        assert.match(p.id, /^pseudo\.pseudo_[a-z_]+$/);
        for (const s of p.forStats) {
            assert.ok(!seen.has(s), `${s} maps twice`);
            seen.add(s);
            assert.ok(pseudoSourceStats(p).includes(s), `${p.id} doesn't count ${s}`);
        }
    }
    const dex = pseudoTotalFor(R.dex);
    assert.equal(dex?.id, PSEUDO.dex);
    assert.ok(dex !== undefined && pseudoSourceStats(dex).includes(R.allAttr));
    assert.equal(pseudoTotalFor(R.life)?.sources.find((s) => `explicit.${s.hash}` === R.str)?.factor, 0.5);
    // Local %ES does not add to the site's increased ES total (V27).
    assert.equal(pseudoTotalFor('explicit.stat_4015621042'), undefined);
});

test('a mod include searches the mod itself; a total is its own pick, with what it counts in the label', () => {
    const spec: SlotSearchSpec = specOf(
        plan([include('suffix', 'Dexterity', R.dex, { min: 40 })], [{ statId: PSEUDO.life, text: '+# total maximum Life', min: 80 }]),
    );
    const reqs: readonly SearchRequirement[] = spec.requirements.filter((r) => r.origin === 'plan');
    assert.deepEqual(
        reqs.map((r) => [r.statId, r.min]),
        [
            [R.dex, 40],
            [PSEUDO.life, 80],
        ],
    );
    assert.match(reqs[1]?.label ?? '', /\+# total maximum Life \(≥ 80\) \(counts .*half of the item's Strength/);
    const unknown: SlotSearchSpec = specOf(
        plan([], [{ statId: 'pseudo.pseudo_number_of_empty_prefix_mods', text: '# Empty Prefix Modifiers', min: 1 }]),
    );
    assert.equal(unknown.requirements.find((r) => r.origin === 'plan')?.label, 'Required: # Empty Prefix Modifiers (≥ 1), from plan');
});

test("a total's own weight is a filter now; its sources keep their weights and it takes no affix", () => {
    const pruned = prunedOf(plan([], [{ statId: PSEUDO.dex, text: 'dex', min: 30 }]), [PSEUDO.dex, R.dex, R.allAttr, R.chaos]);
    assert.equal(pruned.get(PSEUDO.dex), 'included');
    assert.equal(pruned.size, 1);
});

test('three mod includes on one side fill it', () => {
    const own: SlotPlan = plan([
        include('suffix', 'Dexterity', R.dex),
        include('suffix', 'RealFire', R.fire),
        include('suffix', 'RealCold', R.cold),
    ]);
    assert.equal(prunedOf(own, [R.chaos]).get(R.chaos), 'suffixes-full');
});

test('totals are checked: pseudo ids only, each once, sound ranges', () => {
    const bad: SlotPlan = plan(
        [],
        [
            { statId: R.life, text: 'life', min: 1 },
            { statId: PSEUDO.dex, text: 'dex', min: 50, max: 40 },
            { statId: PSEUDO.dex, text: 'dex' },
        ],
    );
    const problems = checkPlan(bad, 'Boots', data()).problems.map((p) => p.code);
    assert.deepEqual(problems, ['bad-total', 'bad-total', 'bad-total']);
    assert.ok(checkPlan(plan([], [{ statId: PSEUDO.dex, text: 'dex', min: 30 }]), 'Boots', data()).ok);
});

test('a hard need and an include on the same total go to the site as one filter with the tighter range', () => {
    const reqs: SearchRequirement[] = [
        { statId: PSEUDO.chaos, min: 20, origin: 'strip', label: 'need' },
        { statId: PSEUDO.chaos, min: 30, max: 60, origin: 'plan', label: 'plan' },
        { statId: PSEUDO.fire, max: 80, origin: 'plan', label: 'fire' },
    ];
    assert.deepEqual(requirementFilters(reqs), [
        { id: PSEUDO.chaos, value: { min: 30, max: 60 } },
        { id: PSEUDO.fire, value: { max: 80 } },
    ]);
    const spec: SlotSearchSpec = specOf(plan([], [{ statId: PSEUDO.chaos, text: 'chaos', min: 30 }]));
    const merged: SlotSearchSpec = {
        ...spec,
        requirements: [{ statId: PSEUDO.chaos, min: 20, origin: 'strip', label: 'need' }, ...spec.requirements],
    };
    const and = compileQuery(merged, SEARCH).body.query.stats.find((g) => g.type === 'and');
    assert.deepEqual(and?.filters, [{ id: PSEUDO.chaos, value: { min: 30 } }]);
});
