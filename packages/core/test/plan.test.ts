import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BandSearch } from '../src/bands.ts';
import type { SlotData } from '@poe-upgrade-finder/engine-client';
import { analysePlan, checkPlan, isEmptyPlan } from '../src/plan.ts';
import type { PlanCheck } from '../src/plan.ts';
import { compileQuery, predictComplexity, QueryCompileError } from '../src/query-compiler.ts';
import type { CompiledQuery } from '../src/query-compiler.ts';
import { BUILD_SOURCES, buildSlotSpec, siteRange } from '../src/slot-spec.ts';
import type { SlotSpecResult } from '../src/slot-spec.ts';
import { composeSpec, saveSpec } from '../src/spec.ts';
import type { PrunedWeight, SlotSearchSpec, WeightedStat } from '../src/spec.ts';
import { bootsContext, bootsData, S } from './plan-fixtures.ts';
import { SLOT_ITEM_TYPES, categoryOf, emptySlotPlan, slotTakes } from '@poe-upgrade-finder/vocab';
import type { ModPick, SlotPlan } from '@poe-upgrade-finder/vocab';

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
    const { pruned } = analysePlan(p, 'Boots', bootsData()).prune(weights);
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
    const p: SlotPlan = emptySlotPlan('Boots');
    assert.equal(isEmptyPlan(p), true);
    // No slot data is needed for it.
    const result: SlotSpecResult = buildSlotSpec(p, { context: bootsContext(weights), slotData: undefined });
    assert.equal(result.ok, true);
    // The build's sources alone: the plan adds nothing.
    const v1: SlotSearchSpec = composeSpec(bootsContext(weights), BUILD_SOURCES);
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

test('a hybrid exclude clashes only with an include that carries all its stats (#38)', () => {
    const essr: Omit<ModPick, 'rule'> = {
        position: 'prefix',
        group: 'LocalEnergyShieldAndStunRecoveryPercent',
        influence: 'none',
        stats: [{ statId: S.es }, { statId: S.sr }],
    };
    const excludeEssr: ModPick = { ...essr, rule: 'exclude' };
    // ES% from the pure mod is fine: only the hybrid mod is dropped after the fetch.
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [ES, excludeEssr]))), []);
    // Including the hybrid's stats in one mod (the same mod, or its craft) while excluding it can't be met.
    assert.deepEqual(codes(check(plan('Sorcerer Boots', [{ ...essr, rule: 'include' }, excludeEssr]))), ['include-and-exclude']);
    // A pure exclude is still a Not group: it clashes with a hybrid include that carries its stat.
    assert.deepEqual(
        codes(check(plan('Sorcerer Boots', [{ ...essr, rule: 'include' }, exclude('prefix', 'LocalEnergyShieldPercent', S.es)]))),
        ['include-and-exclude'],
    );
});

test('two includes on one stat: both ranges are on the total, so they intersect or refuse (issue #71)', () => {
    const pureMana = (range: { min?: number; max?: number }): ModPick => include('prefix', 'IncreasedMana', S.mana, range);
    const esMana = (range: { min?: number; max?: number }): ModPick => ({
        position: 'prefix',
        group: 'LocalEnergyShieldAndManaPercent',
        influence: 'none',
        rule: 'include',
        stats: [{ statId: S.es }, { statId: S.mana, ...range }],
    });
    // Hybrid mana 17 to 25 beside pure mana 40 or more: no total is both.
    const empty: PlanCheck = check(plan('Sorcerer Boots', [esMana({ min: 17, max: 25 }), pureMana({ min: 40 })]));
    assert.deepEqual(codes(empty), ['conflicting-ranges']);
    assert.match(empty.problems[0]?.text ?? '', /Include 1 .*Include 2 .*maximum Mana.*total/);

    // Hybrid mana ≥ 20 beside pure mana ≥ 40: a total of 40 or more, said in a note, not 60.
    const both: PlanCheck = check(plan('Sorcerer Boots', [esMana({ min: 20 }), pureMana({ min: 40 })]));
    assert.equal(both.ok, true);
    assert.equal(both.notes.length, 1);
    assert.match(both.notes[0]?.text ?? '', /total.*≥ 40/);
    const spec: SlotSearchSpec = specOf(plan('Sorcerer Boots', [esMana({ min: 20 }), pureMana({ min: 40 })]));
    const filters = compileQuery(spec, SEARCH).body.query.stats.find((g) => g.type === 'and')?.filters ?? [];
    assert.deepEqual(
        filters.filter((f) => f.id === S.mana),
        [{ id: S.mana, value: { min: 40 } }],
    );
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

test('the plan prunes before the weight review applies, as the review shows it (#111)', () => {
    const result: SlotSpecResult = buildSlotSpec(plan('Sorcerer Boots', [MS]), {
        context: {
            ...bootsContext([
                [S.ms, 2],
                [S.fire, 1],
            ]),
            // Movement speed is both off and included: it reads as pruned, at PoB's weight.
            weightEdits: { [S.fire]: { factor: 4 }, [S.ms]: { off: true, factor: 3 } },
        },
        slotData: bootsData(),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.deepEqual(
            result.spec.weights.map((w) => [w.statId, w.weight]),
            [[S.fire, 4]],
        );
        assert.deepEqual(
            result.spec.pruned.map((p) => [p.statId, p.weight, p.reason]),
            [[S.ms, 2, 'included']],
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

test('weapon hands (#39): Weapon 2 takes only what fits beside Weapon 1; a Weapon 1 two-hander is noted', () => {
    const w2 = (itemType: string | null): SlotPlan => ({ slot: 'Weapon 2', itemType: itemType, base: null, picks: [] });
    const twoHanded = { weapon1Type: 'Two Handed Axe', weapon2Type: null };
    // Beside a two-hander nothing goes in Weapon 2, not even an empty plan (every listing would be skipped).
    const empty: PlanCheck = checkPlan(w2(null), 'Weapon 2', undefined, twoHanded);
    assert.deepEqual(codes(empty), ['offhand-mismatch']);
    assert.equal(empty.problems[0]?.text, 'Weapon 1 is two-handed (a Two Handed Axe): nothing goes in Weapon 2');
    // A sword beside a wand, a quiver beside a sceptre: refused with what fits.
    const sword: PlanCheck = checkPlan(w2('One Handed Sword'), 'Weapon 2', bootsData(), { weapon1Type: 'Wand', weapon2Type: 'Shield' });
    assert.deepEqual(codes(sword), ['offhand-mismatch']);
    assert.equal(sword.problems[0]?.text, "A One Handed Sword can't be held beside a Wand in Weapon 1: Weapon 2 takes Shield, Wand");
    assert.deepEqual(codes(checkPlan(w2('Quiver'), 'Weapon 2', bootsData(), { weapon1Type: null, weapon2Type: null })), [
        'offhand-mismatch',
    ]);
    // What fits goes on to the usual checks (here: the slot data is for boots).
    assert.deepEqual(codes(checkPlan(w2('Shield'), 'Weapon 2', bootsData(), { weapon1Type: 'Wand', weapon2Type: null })), [
        'slot-data-mismatch',
    ]);
    // An empty plan beside a one-hander, and any plan with no gear known, are not checked for hands.
    assert.equal(checkPlan(w2(null), 'Weapon 2', undefined, { weapon1Type: 'Wand', weapon2Type: 'Shield' }).ok, true);
    assert.equal(checkPlan(w2(null), 'Weapon 2', undefined).ok, true);

    // Weapon 1: a bow beside a shield is fine, scored without the shield, and noted.
    const bowData: SlotData = { ...bootsData(), baseType: 'Bow' };
    const bow: PlanCheck = checkPlan({ slot: 'Weapon 1', itemType: 'Bow', base: null, picks: [] }, 'Weapon 1', bowData, {
        weapon1Type: 'Sceptre',
        weapon2Type: 'Shield',
    });
    assert.equal(bow.ok, true);
    assert.deepEqual(
        bow.notes.map((n) => n.code),
        ['offhand-removed'],
    );
    assert.match(bow.notes[0]?.text ?? '', /^A Bow can't be held beside your shield: results are scored with Weapon 2 empty/);
    // A bow beside a quiver: nothing to note.
    const quiver: PlanCheck = checkPlan({ slot: 'Weapon 1', itemType: 'Bow', base: null, picks: [] }, 'Weapon 1', bowData, {
        weapon1Type: 'Bow',
        weapon2Type: 'Quiver',
    });
    assert.deepEqual(quiver.notes, []);
});

test('generic weapon types (#39): a category and totals, no slot data; noted beside an off-hand some results miss', () => {
    const LIFE_TOTAL: string = 'pseudo.pseudo_total_life';
    const any = (itemType: string, extra: Partial<SlotPlan> = {}): SlotPlan => ({
        slot: 'Weapon 1',
        itemType: itemType,
        base: null,
        picks: [],
        ...extra,
    });
    const totals: Partial<SlotPlan> = { totals: [{ statId: LIFE_TOTAL, text: '+# total maximum Life', min: 50 }] };
    // No slot data needed; a base or mods need one item type; defences have nothing to set.
    assert.equal(checkPlan(any('Any weapon', totals), 'Weapon 1', undefined).ok, true);
    assert.deepEqual(codes(checkPlan(any('Any weapon', { base: 'Spine Bow' }), 'Weapon 1', undefined)), ['generic-type']);
    assert.deepEqual(codes(checkPlan(any('Any weapon', { picks: [LIFE] }), 'Weapon 1', undefined)), ['generic-type']);
    assert.deepEqual(codes(checkPlan(any('Any weapon', { defences: { armour: { min: 100 } } }), 'Weapon 1', undefined)), ['no-defences']);
    assert.deepEqual(codes(checkPlan({ ...any('Any weapon'), slot: 'Weapon 2' }, 'Weapon 2', undefined)), ['wrong-slot']);
    assert.deepEqual(
        codes(checkPlan(any('Any weapon', { totals: [{ statId: LIFE_TOTAL, text: 'life', min: 9, max: 1 }] }), 'Weapon 1', undefined)),
        ['bad-total'],
    );

    // The spec searches the site's category and requires the totals.
    const result: SlotSpecResult = buildSlotSpec(any('Two-handed melee', totals), {
        context: { ...bootsContext([]), slot: 'Weapon 1', pobQuery: { category: { query: 'weapon.wand' }, query: { stats: [] } } },
        slotData: undefined,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.spec.category, 'weapon.twomelee');
        assert.equal(result.spec.baseType, null);
        assert.ok(result.spec.requirements.some((r) => r.statId === LIFE_TOTAL && r.min === 50));
    }

    // Pruning: the total's own weight is a filter now; the rest stays (nothing is known about what can roll).
    const { kept, pruned } = analysePlan(any('Any weapon', totals), 'Weapon 1', undefined).prune([
        { statId: LIFE_TOTAL, weight: 1 },
        { statId: S.life, weight: 1 },
    ]);
    assert.deepEqual(
        pruned.map((w: PrunedWeight) => [w.statId, w.reason]),
        [[LIFE_TOTAL, 'included']],
    );
    assert.deepEqual(
        kept.map((w: WeightedStat) => w.statId),
        [S.life],
    );

    // Beside a shield: one-handers fit, two-handers don't.
    const shield = { weapon1Type: 'Wand', weapon2Type: 'Shield' };
    assert.deepEqual(checkPlan(any('One-handed weapon'), 'Weapon 1', undefined, shield).notes, []);
    const anyNote: string = checkPlan(any('Any weapon'), 'Weapon 1', undefined, shield).notes[0]?.text ?? '';
    assert.equal(
        anyNote,
        "Some results can't be held beside your shield (Bow, Staff, Two Handed Axe and 2 more): those are scored with Weapon 2 empty, " +
            'so their gain includes losing it. Results may look odd next to the rest',
    );
    assert.match(
        checkPlan(any('Two-handed melee'), 'Weapon 1', undefined, shield).notes[0]?.text ?? '',
        /^No two-handed melee can be held beside your shield: results are scored with Weapon 2 empty/,
    );
    // Beside a wand in Weapon 2: only wands fit, so one-handers are noted too. No off-hand: nothing to note.
    assert.match(
        checkPlan(any('One-handed weapon'), 'Weapon 1', undefined, { weapon1Type: 'Wand', weapon2Type: 'Wand' }).notes[0]?.text ?? '',
        /^Some results can't be held beside your wand \(Claw, Dagger, One Handed Axe and 3 more\)/,
    );
    assert.deepEqual(checkPlan(any('Any weapon'), 'Weapon 1', undefined, { weapon1Type: 'Wand', weapon2Type: null }).notes, []);
});
