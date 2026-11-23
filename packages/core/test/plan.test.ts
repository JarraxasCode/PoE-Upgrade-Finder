import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BandSearch } from '../src/bands.ts';
import type { SlotData } from '@poe-upgrade-finder/engine-client';
import { categoryOf, SLOT_ITEM_TYPES, slotTakes } from '../src/item-types.ts';
import { checkPlan, emptyPlan, isEmptyPlan, pruneWeights } from '../src/plan.ts';
import type { ModPick, PlanCheck, SlotPlan } from '../src/plan.ts';
import { compileQuery, predictComplexity, QueryCompileError } from '../src/query-compiler.ts';
import type { CompiledQuery } from '../src/query-compiler.ts';
import { buildSlotSpec, siteRange } from '../src/slot-spec.ts';
import type { SlotSpecResult } from '../src/slot-spec.ts';
import { saveSpec } from '../src/spec.ts';
import type { PrunedWeight, SlotSearchSpec, WeightedStat } from '../src/spec.ts';
import { v1SpecBuilder } from '../src/v1.ts';
import { bootsContext, bootsData, S } from './plan-fixtures.ts';

const SEARCH: BandSearch = { bandId: 'band-2', option: 'chaos', price: { min: 1, max: 33.33, option: 'chaos' } };

function include(position: ModPick['position'], group: string | null, statId: string, range: { min?: number; max?: number } = {}): ModPick {
    return { position: position, group: group, influence: 'none', rule: 'include', stats: [{ statId: statId, ...range }] };
}

function exclude(position: ModPick['position'], group: string | null, statId: string): ModPick {
    return { position: position, group: group, influence: 'none', rule: 'exclude', stats: [{ statId: statId }] };
}

function plan(base: string | null, picks: readonly ModPick[]): SlotPlan {
    return { slot: 'Boots', itemType: 'Boots', base: base, picks: picks };
}

function check(p: SlotPlan): PlanCheck {
    return checkPlan(p, 'Boots', bootsData());
}

function codes(c: PlanCheck): readonly string[] {
    return c.problems.map((p) => p.code);
}

function specOf(p: SlotPlan, weights: readonly (readonly [string, number])[] = []): SlotSearchSpec {
    const result: SlotSpecResult = buildSlotSpec(p, { context: bootsContext(weights), slotData: bootsData() });
    if (!result.ok) {
        assert.fail(`refused: ${result.check.problems.map((x) => x.text).join('; ')}`);
    }
    return result.spec;
}

function prunedOf(p: SlotPlan, ids: readonly string[]): ReadonlyMap<string, PrunedWeight['reason']> {
    const weights: WeightedStat[] = ids.map((id: string) => ({ statId: id, weight: 1 }));
    const { pruned } = pruneWeights(weights, p, 'Boots', bootsData());
    return new Map(pruned.map((w: PrunedWeight) => [w.statId, w.reason]));
}

const MS: ModPick = include('prefix', 'MovementVelocity', S.ms, { min: 20, max: 30 });
const LIFE: ModPick = include('prefix', 'IncreasedLife', S.life, { min: 60 });
const FLAT_ES: ModPick = include('prefix', 'LocalEnergyShield', S.flatEs);
const ES: ModPick = include('prefix', 'LocalEnergyShieldPercent', S.es, { min: 40 });

// ---- An empty plan --------------------------------------------------------------------------------------

test('an empty plan searches exactly as v0.1: same spec, same query body', () => {
    const weights: readonly (readonly [string, number])[] = [
        [S.ms, 3],
        [S.evasion, 1],
        ['pseudo.pseudo_total_fire_resistance', 1],
    ];
    const p: SlotPlan = emptyPlan('Boots');
    assert.equal(isEmptyPlan(p), true);
    // No slot data is needed for it.
    const result: SlotSpecResult = buildSlotSpec(p, { context: bootsContext(weights), slotData: undefined });
    assert.equal(result.ok, true);
    const v1: SlotSearchSpec = v1SpecBuilder().build(bootsContext(weights));
    if (result.ok) {
        // The checks are fresh closures per build, so compare the saved (JSON-safe) form.
        assert.deepEqual(saveSpec(result.spec), saveSpec(v1));
        assert.deepEqual(
            result.spec.checks.map((c) => c.id),
            v1.checks.map((c) => c.id),
        );
        assert.deepEqual(compileQuery(result.spec, SEARCH).body, compileQuery(v1, SEARCH).body);
        assert.equal(compileQuery(result.spec, SEARCH).body.query.type, undefined);
    }
});

// ---- The spec from a plan -------------------------------------------------------------------------------

test('includes become plan requirements with their ranges and labels; excludes a Not group; the base the site type', () => {
    const spec: SlotSearchSpec = specOf(
        plan('Two-Toned Boots (Armour/Evasion)', [
            MS,
            include('suffix', 'ColdResistance', S.cold, { max: 40 }),
            include('implicit', null, S.fireCold, { min: 10 }),
            exclude('suffix', 'ItemFoundRarityIncrease', S.rarity),
            exclude('prefix', 'IncreasedMana', S.mana),
        ]),
        [[S.life, 2]],
    );
    assert.equal(spec.baseType, 'Two-Toned Boots');
    assert.deepEqual(
        spec.requirements.map((r) => [r.statId, r.min, r.max, r.origin, r.label]),
        [
            [S.ms, 20, 30, 'plan', 'Required: #% increased Movement Speed (20 to 30), from plan'],
            [S.cold, undefined, 40, 'plan', 'Required: +#% to Cold Resistance (≤ 40), from plan'],
            [S.fireCold, 10, undefined, 'plan', 'Required: +#% to Fire and Cold Resistances (≥ 10), from plan'],
        ],
    );
    assert.deepEqual(
        spec.exclusions.map((e) => [e.statId, e.label]),
        [
            [S.rarity, 'Excluded: #% increased Rarity of Items found, from plan'],
            [S.mana, 'Excluded: +# to maximum Mana, from plan'],
        ],
    );
    const q: CompiledQuery = compileQuery(spec, SEARCH);
    assert.equal(q.body.query.type, 'Two-Toned Boots');
    assert.deepEqual(
        q.body.query.stats.map((g) => g.type),
        ['weight', 'and', 'not'],
    );
    assert.deepEqual(q.body.query.stats[2]?.filters, [{ id: S.rarity }, { id: S.mana }]);
    assert.deepEqual(q.body.query.stats[1]?.filters[0], { id: S.ms, value: { min: 20, max: 30 } });
    // V24: type +1, And +1 per stat (+1), Not +1 for the group and +1 per stat.
    assert.equal(q.complexity, 10 + 50 + 4 + (3 + 1) + (2 + 1) + 1);
    assert.equal(q.complexity, predictComplexity(1, 3, { excluded: 2, typed: true, influences: 0 }));
});

test('a reduced mod is entered as it reads and sent negated and swapped', () => {
    assert.deepEqual(siteRange({ statId: S.attrReq, min: 20, max: 32 }, true), { min: -32, max: -20 });
    assert.deepEqual(siteRange({ statId: S.attrReq, min: 20 }, true), { max: -20 });
    assert.deepEqual(siteRange({ statId: S.attrReq, max: 32 }, true), { min: -32 });
    assert.deepEqual(siteRange({ statId: S.ms, min: 20 }, false), { min: 20 });
    const spec: SlotSearchSpec = specOf(
        plan('Sorcerer Boots', [include('suffix', 'LocalAttributeRequirements', S.attrReq, { min: 20, max: 32 })]),
    );
    assert.deepEqual(
        spec.requirements.map((r) => [r.min, r.max, r.label]),
        [[-32, -20, 'Required: #% reduced Attribute Requirements (20 to 32), from plan']],
    );
});

test('a hybrid include sends every stat of the mod, each with its own range', () => {
    const hybrid: ModPick = {
        position: 'prefix',
        group: 'LocalEnergyShieldAndStunRecoveryPercent',
        influence: 'none',
        rule: 'include',
        stats: [{ statId: S.es, min: 30 }, { statId: S.sr }],
    };
    const spec: SlotSearchSpec = specOf(plan('Sorcerer Boots', [hybrid]));
    assert.deepEqual(
        spec.requirements.map((r) => [r.statId, r.min]),
        [
            [S.es, 30],
            [S.sr, undefined],
        ],
    );
});

test('an influenced include adds its influence filter', () => {
    const shaper: ModPick = { ...include('suffix', 'ShaperSuffix', S.shaper), influence: 'shaper' };
    const spec: SlotSearchSpec = specOf(plan('Sorcerer Boots', [shaper]));
    assert.deepEqual(spec.influences, ['shaper']);
    const q: CompiledQuery = compileQuery(spec, SEARCH);
    assert.deepEqual(q.body.query.filters.misc_filters, { filters: { shaper_item: { option: 'true' } } });
    assert.equal(q.complexity, predictComplexity(0, 1, { excluded: 0, typed: true, influences: 1 }));
});

test('the plan is never trimmed: weights go first, and a plan alone over the limit is refused', () => {
    const many: (readonly [string, number])[] = [];
    for (let i: number = 0; i < 40; i++) {
        many.push([`pseudo.w${i}`, 40 - i]);
    }
    const spec: SlotSearchSpec = specOf(plan('Sorcerer Boots', [MS, LIFE, exclude('suffix', 'ItemFoundRarityIncrease', S.rarity)]), many);
    const q: CompiledQuery = compileQuery(spec, SEARCH);
    // 10 + type 1 + And 3 + Not 2 = 16, so 33 weights fit (16 + 50 + 132 = 198).
    assert.equal(q.weightsUsed, 33);
    assert.equal(q.complexity, 198);
    assert.equal(q.body.query.stats[1]?.filters.length, 2);
    assert.equal(q.body.query.stats[2]?.filters.length, 1);
    const huge: SlotSearchSpec = {
        ...spec,
        exclusions: Array.from({ length: 190 }, (_: unknown, i: number) => ({
            statId: `explicit.x${i}`,
            origin: 'plan' as const,
            label: '',
        })),
    };
    assert.throws(() => compileQuery(huge, SEARCH), QueryCompileError);
});

// ---- Feasibility ----------------------------------------------------------------------------------------

test('a plan for another slot, without slot data, for another item type or an unknown base is refused', () => {
    assert.deepEqual(codes(checkPlan({ ...plan(null, [MS]), slot: 'Gloves' }, 'Boots', bootsData())), ['slot-mismatch', 'wrong-slot']);
    assert.deepEqual(codes(checkPlan(plan(null, [MS]), 'Boots', undefined)), ['no-slot-data']);
    assert.deepEqual(codes(check({ ...plan(null, [MS]), itemType: 'Gloves' })), ['wrong-slot']);
    assert.deepEqual(codes(checkPlan({ slot: 'Weapon 1', itemType: 'Bow', base: null, picks: [MS] }, 'Weapon 1', bootsData())), [
        'slot-data-mismatch',
    ]);
    assert.deepEqual(codes(check(plan('Iron Greaves', [MS]))), ['unknown-base']);
});

test('at most 3 prefix and 3 suffix includes; implicits do not count', () => {
    const fourPrefixes: SlotPlan = plan('Sorcerer Boots', [MS, LIFE, FLAT_ES, ES]);
    assert.deepEqual(codes(check(fourPrefixes)), ['too-many-prefixes']);
    const suffixes: ModPick[] = [
        include('suffix', 'FireResistance', S.fire),
        include('suffix', 'ColdResistance', S.cold),
        include('suffix', 'ChaosResistance', S.chaos),
        include('suffix', 'StunRecovery', S.sr),
    ];
    assert.deepEqual(codes(check(plan('Sorcerer Boots', suffixes))), ['too-many-suffixes']);
    const withImplicits: SlotPlan = plan('Sorcerer Boots', [
        MS,
        LIFE,
        FLAT_ES,
        include('implicit', 'ExarchA', S.exarchA),
        include('implicit', 'EaterA', S.eater),
    ]);
    assert.equal(check(withImplicits).ok, true);
});

test('two includes from one mod group are refused', () => {
    const regen: ModPick = include('prefix', 'IncreasedLife', S.lifeRegen);
    const c: PlanCheck = check(plan('Sorcerer Boots', [LIFE, regen]));
    assert.deepEqual(codes(c), ['same-group']);
    assert.equal(c.problems[0]?.pick, 1);
});

test('an implicit and an affix may share a mod group; two affixes may not (issue #30)', () => {
    const suffix: ModPick = include('suffix', 'ChaosResistance', S.chaos, { min: 20 });
    const implicit: ModPick = include('implicit', 'ChaosResistance', S.chaosImplicit);
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [suffix, implicit]))), []);
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [implicit, suffix]))), []);
    // Within affixes the rule still holds, whatever else is in the plan.
    const regen: ModPick = include('prefix', 'IncreasedLife', S.lifeRegen);
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [implicit, LIFE, regen]))), ['same-group']);
    // The included suffix pins its group for affixes only: the implicit's weight stays.
    assert.equal(prunedOf(plan('Sorcerer Boots', [suffix]), [S.chaosImplicit]).has(S.chaosImplicit), false);
});

test('an include must roll on the base, on its side and in its pool', () => {
    // Evasion: Slink Boots only.
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [include('prefix', 'LocalEvasionRatingIncreasePercent', S.evasion)]))), [
        'cannot-roll',
    ]);
    assert.equal(check(plan('Slink Boots', [include('prefix', 'LocalEvasionRatingIncreasePercent', S.evasion)])).ok, true);
    // Any base: fine if one base rolls it.
    assert.equal(check(plan(null, [include('prefix', 'LocalEvasionRatingIncreasePercent', S.evasion)])).ok, true);
    // Movement speed is a prefix.
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [include('suffix', 'MovementVelocity', S.ms)]))), ['cannot-roll']);
    // A Shaper mod needs its influence named, and a base that takes influence.
    const shaper: ModPick = include('suffix', 'ShaperSuffix', S.shaper);
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [shaper]))), ['cannot-roll']);
    assert.deepEqual(codes(check(plan('Slink Boots', [{ ...shaper, influence: 'shaper' }]))), ['cannot-roll']);
    // A base implicit must be on the base.
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [include('implicit', null, S.fireCold)]))), ['cannot-roll']);
    // Every stat of the pick must be on the one mod.
    const bad: ModPick = { ...MS, stats: [{ statId: S.ms }, { statId: S.life }] };
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [bad]))), ['cannot-roll']);
});

test('one Exarch and one Eater implicit at most; at most two influences', () => {
    const twoExarch: SlotPlan = plan('Sorcerer Boots', [
        include('implicit', 'ExarchA', S.exarchA),
        include('implicit', 'ExarchB', S.exarchB),
    ]);
    assert.deepEqual(codes(check(twoExarch)), ['eldritch-limit']);
    const three: SlotPlan = plan('Sorcerer Boots', [
        { ...include('suffix', 'ShaperSuffix', S.shaper), influence: 'shaper' },
        { ...include('suffix', 'ElderSuffix', S.elder), influence: 'elder' },
        { ...include('suffix', 'CrusaderSuffix', S.crusader), influence: 'crusader' },
    ]);
    assert.deepEqual(codes(check(three)), ['too-many-influences']);
    const two: PlanCheck = check(plan('Sorcerer Boots', three.picks.slice(0, 2)));
    assert.equal(two.ok, true);
    assert.deepEqual(two.influences, ['shaper', 'elder']);
});

test('bad ranges, empty picks, and a stat both included and excluded are refused', () => {
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [include('prefix', 'MovementVelocity', S.ms, { min: 30, max: 20 })]))), [
        'bad-range',
    ]);
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [include('prefix', 'MovementVelocity', S.ms, { min: Number.NaN })]))), [
        'bad-range',
    ]);
    const ranged: ModPick = { ...exclude('prefix', 'IncreasedMana', S.mana), stats: [{ statId: S.mana, min: 10 }] };
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [ranged]))), ['bad-range']);
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [{ ...MS, stats: [] }]))), ['empty-pick']);
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [MS, exclude('prefix', 'MovementVelocity', S.ms)]))), ['include-and-exclude']);
});

test('a refused plan gives no spec', () => {
    const result: SlotSpecResult = buildSlotSpec(plan('Sorcerer Boots', [MS, LIFE, FLAT_ES, ES]), {
        context: bootsContext([]),
        slotData: bootsData(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.check.problems[0]?.code, 'too-many-prefixes');
});

test('an exclude the includes leave no room for is dropped with a note; one the base cannot roll is kept', () => {
    // MS, life and flat ES fill the prefixes: no mana mod can be on the item.
    const p: SlotPlan = plan('Sorcerer Boots', [
        MS,
        LIFE,
        FLAT_ES,
        exclude('prefix', 'IncreasedMana', S.mana),
        exclude('prefix', 'LocalEvasionRatingIncreasePercent', S.evasion),
    ]);
    const c: PlanCheck = check(p);
    assert.equal(c.ok, true);
    assert.deepEqual(
        c.notes.map((n) => [n.code, n.pick]),
        [['redundant-exclude', 3]],
    );
    const spec: SlotSearchSpec = specOf(p, [[S.mana, 1]]);
    assert.deepEqual(
        spec.exclusions.map((e) => e.statId),
        [S.evasion],
    );
    // Its weight still says why: excluded.
    assert.deepEqual(
        spec.pruned.map((w) => [w.statId, w.reason]),
        [[S.mana, 'excluded']],
    );
});

// ---- Weight pruning -------------------------------------------------------------------------------------

test('included and excluded stats leave the weighted group; pseudo weights stay', () => {
    const r = prunedOf(plan(null, [MS, exclude('suffix', 'ItemFoundRarityIncrease', S.rarity)]), [
        S.ms,
        S.rarity,
        S.life,
        'pseudo.pseudo_total_life',
    ]);
    assert.deepEqual(
        [...r],
        [
            [S.ms, 'included'],
            [S.rarity, 'excluded'],
        ],
    );
});

test('with a base chosen, weights it cannot roll go; with any base they stay', () => {
    assert.deepEqual([...prunedOf(plan('Sorcerer Boots', []), [S.evasion, S.life])], [[S.evasion, 'base-cannot-roll']]);
    assert.deepEqual([...prunedOf(plan(null, [MS]), [S.evasion])], []);
});

test('a group taken by an include drops the other stats in it', () => {
    // Every mod with max Life is in IncreasedLife, so the item has one; Life Regen is in the same group.
    assert.deepEqual([...prunedOf(plan('Sorcerer Boots', [LIFE]), [S.lifeRegen, S.mana])], [[S.lifeRegen, 'same-group']]);
});

test('three prefix includes drop prefix-only weights; a stat that can also be a suffix stays', () => {
    const r = prunedOf(plan('Sorcerer Boots', [MS, LIFE, FLAT_ES]), [S.mana, S.es, S.rarity, S.fire, S.sr]);
    assert.deepEqual(
        [...r],
        [
            [S.mana, 'prefixes-full'],
            [S.es, 'prefixes-full'],
            // Stun Recovery: the pure suffix is still free (its hybrid prefix is not).
        ],
    );
});

test('both sides full drop a two-sided stat', () => {
    const p: SlotPlan = plan('Sorcerer Boots', [
        MS,
        LIFE,
        FLAT_ES,
        include('suffix', 'FireResistance', S.fire),
        include('suffix', 'ColdResistance', S.cold),
        include('suffix', 'ChaosResistance', S.chaos),
    ]);
    assert.deepEqual(
        [...prunedOf(p, [S.rarity, S.sr])],
        [
            [S.rarity, 'affixes-full'],
            [S.sr, 'affixes-full'],
        ],
    );
});

test('a hybrid that could meet an include keeps its other stat, even with the side full', () => {
    // ES% can come from the ES / Mana hybrid, so mana can still be on the item next to MS and life.
    const r = prunedOf(plan('Sorcerer Boots', [MS, LIFE, ES]), [S.mana, S.sr, S.flatEs]);
    assert.deepEqual([...r], [[S.flatEs, 'prefixes-full']]);
});

test('two includes one hybrid can meet together take one prefix, not two', () => {
    const mana: ModPick = include('prefix', 'IncreasedMana', S.mana);
    // ES% and mana may be one ES / Mana hybrid: a prefix is still free for life.
    assert.deepEqual([...prunedOf(plan('Sorcerer Boots', [MS, ES, mana]), [S.life, S.flatEs])], []);
});

test('two pinned influences limit the pools; one leaves every other influence possible', () => {
    // With only Shaper pinned, an Elder mod could still be on the item.
    const shaper: ModPick = { ...include('suffix', 'ShaperSuffix', S.shaper), influence: 'shaper' };
    const p: SlotPlan = plan('Sorcerer Boots', [shaper]);
    assert.deepEqual([...prunedOf(p, [S.elder, S.crusader])], []);
    const elder: ModPick = { ...include('suffix', 'ElderSuffix', S.elder), influence: 'elder' };
    assert.deepEqual([...prunedOf(plan('Sorcerer Boots', [shaper, elder]), [S.crusader])], [[S.crusader, 'base-cannot-roll']]);
});

test('kept weights keep their order, and the pruning goes into the spec with its reasons', () => {
    const spec: SlotSearchSpec = specOf(plan('Sorcerer Boots', [MS, LIFE, FLAT_ES]), [
        [S.fire, 3],
        [S.mana, 2.5],
        [S.ms, 2],
        ['pseudo.pseudo_total_cold_resistance', 1.5],
        [S.evasion, 1],
        [S.sr, 0.5],
    ]);
    assert.deepEqual(
        spec.weights.map((w) => w.statId),
        [S.fire, 'pseudo.pseudo_total_cold_resistance', S.sr],
    );
    assert.deepEqual(
        spec.pruned.map((w) => [w.statId, w.weight, w.reason, w.text]),
        [
            [S.mana, 2.5, 'prefixes-full', 'The includes fill all 3 prefixes'],
            [S.ms, 2, 'included', 'Included in the slot plan: a filter now'],
            [S.evasion, 1, 'base-cannot-roll', "Sorcerer Boots can't roll it"],
        ],
    );
});

test('the user weight review is applied before the pruning', () => {
    const result: SlotSpecResult = buildSlotSpec(plan('Sorcerer Boots', [MS]), {
        context: {
            ...bootsContext([
                [S.ms, 2],
                [S.fire, 1],
            ]),
            weightEdits: { [S.fire]: 4 },
        },
        slotData: bootsData(),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.deepEqual(
            result.spec.weights.map((w) => [w.statId, w.weight]),
            [[S.fire, 4]],
        );
    }
});

// ---- Item type and category ------------------------------------------------------------------------------

test("the plan's item type picks the category; a base adds the site type; none keeps PoB's", () => {
    // PoB's category comes from the equipped item (here: boots). A plan with only the item type searches every base of it.
    const typeOnly: SlotPlan = { slot: 'Boots', itemType: 'Boots', base: null, picks: [] };
    assert.equal(isEmptyPlan(typeOnly), false);
    const spec: SlotSearchSpec = specOf(typeOnly);
    assert.equal(spec.category, 'armour.boots');
    assert.equal(spec.baseType, null);
    assert.equal(specOf(plan('Sorcerer Boots', [])).baseType, 'Sorcerer Boots');
});

test('a weapon slot searches the type the plan names, not the equipped one', () => {
    // A bow plan on a sword slot: the category follows the plan (PoB still scores whatever comes back).
    const bows: SlotData = { ...bootsData(), baseType: 'Bow' };
    const result: SlotSpecResult = buildSlotSpec(
        { slot: 'Weapon 1', itemType: 'Bow', base: null, picks: [] },
        {
            context: { ...bootsContext([]), slot: 'Weapon 1', pobQuery: { category: { query: 'weapon.onesword' }, query: { stats: [] } } },
            slotData: bows,
        },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.spec.category, 'weapon.bow');
        assert.equal(compileQuery(result.spec, SEARCH).body.query.filters.type_filters.filters.category.option, 'weapon.bow');
    }
    // PoB's own map: a rune dagger is a Dagger, a warstaff a Staff.
    assert.equal(categoryOf('Dagger'), 'weapon.dagger');
    assert.equal(categoryOf('Staff'), 'weapon.staff');
    assert.equal(categoryOf('Fishing Rod'), undefined);
});

test('a slot only takes the item types it can hold', () => {
    const bowOffHand: PlanCheck = checkPlan({ slot: 'Weapon 2', itemType: 'Bow', base: null, picks: [] }, 'Weapon 2', bootsData());
    assert.deepEqual(codes(bowOffHand), ['wrong-slot']);
    assert.deepEqual(codes(checkPlan({ slot: 'Weapon 1', itemType: 'Shield', base: null, picks: [] }, 'Weapon 1', bootsData())), [
        'wrong-slot',
    ]);
    assert.deepEqual(codes(checkPlan({ slot: 'Boots', itemType: 'Gloves', base: null, picks: [] }, 'Boots', bootsData())), ['wrong-slot']);
    assert.equal(slotTakes('Weapon 2', 'Quiver'), true);
    assert.equal(slotTakes('Weapon 1', 'Two Handed Sword'), true);
    for (const types of Object.values(SLOT_ITEM_TYPES)) {
        for (const t of types) {
            assert.ok(categoryOf(t) !== undefined, `${t} has a category`);
        }
    }
});
