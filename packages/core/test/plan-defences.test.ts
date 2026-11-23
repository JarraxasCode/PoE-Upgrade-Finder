// The slot plan's defence ranges (issue #24): checks, pruning and the site's armour filters. The fixture's
// bases: Sorcerer Boots (Energy Shield), Slink Boots (Evasion), Two-Toned Boots (Armour and Evasion).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BandSearch } from '../src/bands.ts';
import { checkPlan, isEmptyPlan, localDefences, pruneWeights } from '../src/plan.ts';
import type { ModPick, PlanCheck, PlanDefences, SlotPlan } from '../src/plan.ts';
import { compileQuery, predictComplexity } from '../src/query-compiler.ts';
import { buildSlotSpec } from '../src/slot-spec.ts';
import type { SlotSpecResult } from '../src/slot-spec.ts';
import type { PrunedWeight, SlotSearchSpec, WeightedStat } from '../src/spec.ts';
import { bootsContext, bootsData, S } from './plan-fixtures.ts';

const SEARCH: BandSearch = { bandId: 'band-2', option: 'chaos', price: { min: 1, max: 33.33, option: 'chaos' } };

function plan(base: string | null, defences: PlanDefences, picks: readonly ModPick[] = []): SlotPlan {
    return { slot: 'Boots', itemType: 'Boots', base: base, picks: picks, defences: defences };
}

function codes(c: PlanCheck): readonly string[] {
    return c.problems.map((p) => p.code);
}

function specOf(p: SlotPlan): SlotSearchSpec {
    const result: SlotSpecResult = buildSlotSpec(p, { context: bootsContext([]), slotData: bootsData() });
    if (!result.ok) {
        assert.fail(`refused: ${result.check.problems.map((x) => x.text).join('; ')}`);
    }
    return result.spec;
}

function prunedOf(p: SlotPlan, ids: readonly string[]): ReadonlyMap<string, PrunedWeight> {
    const weights: WeightedStat[] = ids.map((id: string) => ({ statId: id, weight: 1 }));
    const { pruned } = pruneWeights(weights, p, 'Boots', bootsData());
    return new Map(pruned.map((w: PrunedWeight) => [w.statId, w]));
}

test('local defence stats are read from the site wording; global ones add to none', () => {
    assert.deepEqual(localDefences('#% increased Energy Shield (Local)'), ['energyShield']);
    assert.deepEqual(localDefences('#% increased Armour and Evasion (Local)'), ['armour', 'evasion']);
    assert.deepEqual(localDefences('#% increased Armour, Evasion and Energy Shield (Local)'), ['armour', 'evasion', 'energyShield']);
    assert.deepEqual(localDefences('+# to Ward (Local)'), ['ward']);
    assert.deepEqual(localDefences('+# to maximum Energy Shield'), []);
    assert.deepEqual(localDefences('Adds # to # Physical Damage (Local)'), []);
});

test('defences compile to the armour filters, n + 1 complexity, with labels in the spec', () => {
    const spec: SlotSearchSpec = specOf(plan(null, { energyShield: { max: 0 }, armour: { min: 100, max: 300 } }));
    assert.deepEqual(
        spec.defences.map((d) => [d.defence, d.min, d.max, d.label]),
        [
            ['armour', 100, 300, 'Armour (100 to 300), from plan'],
            ['energyShield', undefined, 0, 'Energy Shield (≤ 0), from plan'],
        ],
    );
    const q = compileQuery(spec, SEARCH);
    assert.deepEqual(q.body.query.filters.armour_filters, { filters: { ar: { min: 100, max: 300 }, es: { max: 0 } } });
    assert.equal(q.complexity, predictComplexity(0, 0, { excluded: 0, typed: false, influences: 0, defences: 2 }));
    // The armour filters cost n + 1 (live, 23 Nov: 27 weights and 4 defences were 173 on the site).
    assert.equal(q.complexity, 13);
    assert.equal(predictComplexity(27, 0, { excluded: 0, typed: false, influences: 0, defences: 4 }), 173);
});

test('empty defence ranges are no plan and send no armour filter', () => {
    const p: SlotPlan = { slot: 'Boots', itemType: null, base: null, picks: [], defences: { evasion: {} } };
    assert.ok(isEmptyPlan(p));
    assert.equal(compileQuery(specOf(p), SEARCH).body.query.filters.armour_filters, undefined);
    assert.ok(!isEmptyPlan({ ...p, itemType: 'Boots', defences: { evasion: { max: 0 } } }));
});

test('bad ranges, a defence on an item type without any, and a base that always or never has it are refused', () => {
    const data = bootsData();
    assert.deepEqual(codes(checkPlan(plan(null, { armour: { min: 300, max: 100 } }), 'Boots', data)), ['bad-defence']);
    assert.deepEqual(codes(checkPlan(plan(null, { armour: { min: 1.5 } }), 'Boots', data)), ['bad-defence']);
    assert.deepEqual(codes(checkPlan(plan(null, { armour: { max: -1 } }), 'Boots', data)), ['bad-defence']);
    const ring: SlotPlan = { slot: 'Ring 1', itemType: 'Ring', base: null, picks: [], defences: { energyShield: { min: 10 } } };
    assert.deepEqual(codes(checkPlan(ring, 'Ring 1', undefined)), ['no-defences']);

    const always: PlanCheck = checkPlan(plan('Sorcerer Boots', { energyShield: { max: 0 } }), 'Boots', data);
    assert.deepEqual(codes(always), ['defence-always']);
    assert.match(always.problems[0]?.text ?? '', /Sorcerer Boots always has Energy Shield/);
    assert.deepEqual(codes(checkPlan(plan(null, { ward: { min: 10 } }), 'Boots', data)), ['defence-never']);
    // Each is possible alone, but no base has none of the three.
    assert.deepEqual(codes(checkPlan(plan(null, { armour: { max: 0 }, evasion: { max: 0 }, energyShield: { max: 0 } }), 'Boots', data)), [
        'defences-no-base',
    ]);
    // A min of 0 asks for nothing.
    assert.ok(checkPlan(plan('Sorcerer Boots', { armour: { min: 0 } }), 'Boots', data).ok);
});

test('an include that adds a defence set to at most 0 is refused', () => {
    const flatEs: ModPick = {
        position: 'prefix',
        group: 'LocalEnergyShield',
        influence: 'none',
        rule: 'include',
        stats: [{ statId: S.flatEs }],
    };
    const c: PlanCheck = checkPlan(plan(null, { energyShield: { max: 0 } }, [flatEs]), 'Boots', bootsData());
    assert.deepEqual(codes(c), ['include-and-defence']);
    assert.match(c.problems[0]?.text ?? '', /adds Energy Shield/);
});

test('a defence at max 0 prunes its local mods; mods only bases without the defences roll go too', () => {
    // Max ES 0: Slink and Two-Toned are left. Life regen only rolls on Sorcerer Boots here.
    const p: SlotPlan = plan(null, { energyShield: { max: 0 } });
    const out = prunedOf(p, [S.es, S.flatEs, S.lifeRegen, S.mana, S.sr, S.ms, S.evasion]);
    assert.deepEqual([...out.keys()].sort(), [S.es, S.flatEs, S.lifeRegen].sort());
    assert.equal(out.get(S.es)?.reason, 'defences');
    assert.match(out.get(S.es)?.text ?? '', /Energy Shield is at most 0/);
    assert.match(out.get(S.lifeRegen)?.text ?? '', /No base with the plan's defences/);

    // Min ES 100: only Sorcerer Boots are left, so the local evasion mod goes.
    const es: ReadonlyMap<string, PrunedWeight> = prunedOf(plan(null, { energyShield: { min: 100 } }), [S.evasion, S.es]);
    assert.deepEqual([...es.keys()], [S.evasion]);
});

test('defences leave the plan as searched and a refused plan prunes nothing', () => {
    const refused: SlotPlan = plan('Sorcerer Boots', { energyShield: { max: 0 } });
    assert.equal(prunedOf(refused, [S.es]).size, 0);
    const ok: PlanCheck = checkPlan(plan(null, { evasion: { min: 50 } }), 'Boots', bootsData());
    assert.deepEqual(ok.plan.defences, { evasion: { min: 50 } });
});
