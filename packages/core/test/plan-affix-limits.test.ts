// Bases with other affix limits (issue #37): the plan check and the pruning count against each base's own
// limits, from its implicits. Ring data with PoB 2.68.1's implicit lines (plan-fixtures.ts, ringData).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysePlan, checkPlan } from '../src/plan.ts';
import type { AnalysedPlan, PlanCheck } from '../src/plan.ts';
import type { PrunedWeight, WeightedStat } from '../src/spec.ts';
import { ringData, S } from './plan-fixtures.ts';
import type { ModPick, SlotPlan } from '@poe-upgrade-finder/vocab';

function include(position: 'prefix' | 'suffix', group: string, statId: string): ModPick {
    return { position: position, group: group, influence: 'none', rule: 'include', stats: [{ statId: statId }] };
}

const LIFE: ModPick = include('prefix', 'IncreasedLife', S.life);
const MANA: ModPick = include('prefix', 'IncreasedMana', S.mana);
const RARITY_PREFIX: ModPick = include('prefix', 'ItemFoundRarityIncreasePrefix', S.rarity);
const FIRE: ModPick = include('suffix', 'FireResistance', S.fire);
const COLD: ModPick = include('suffix', 'ColdResistance', S.cold);
const CHAOS: ModPick = include('suffix', 'ChaosResistance', S.chaos);
const STUN: ModPick = include('suffix', 'StunRecovery', S.sr);

function ring(base: string | null, picks: readonly ModPick[]): SlotPlan {
    return { slot: 'Ring 1', itemType: 'Ring', base: base, picks: picks };
}

function check(p: SlotPlan): PlanCheck {
    return checkPlan(p, 'Ring 1', ringData());
}

function pruned(p: SlotPlan, ids: readonly string[]): ReadonlyMap<string, readonly [string, string]> {
    const weights: WeightedStat[] = ids.map((id: string) => ({ statId: id, weight: 1 }));
    const analysed: AnalysedPlan = analysePlan(p, 'Ring 1', ringData());
    assert.deepEqual(analysed.check.problems, []);
    return new Map(analysed.prune(weights).pruned.map((w: PrunedWeight) => [w.statId, [w.reason, w.text] as const]));
}

test('Ratcheting Ring (0 prefixes / 6 suffixes): a prefix include is refused, not searched for nothing', () => {
    const c: PlanCheck = check(ring('Ratcheting Ring', [LIFE]));
    assert.deepEqual(
        c.problems.map((p) => [p.code, p.text]),
        [['too-many-prefixes', '1 prefix include: Ratcheting Ring has no prefixes']],
    );
    // Any ring base can still hold it.
    assert.ok(check(ring(null, [LIFE])).ok);
});

test('Helical Ring (1 / 4) takes 4 suffix includes; a plain ring does not', () => {
    assert.ok(check(ring('Helical Ring', [FIRE, COLD, CHAOS, STUN])).ok);
    assert.deepEqual(
        check(ring('Iron Ring', [FIRE, COLD, CHAOS, STUN])).problems.map((p) => p.text),
        ['4 suffix includes: Iron Ring has at most 3'],
    );
    // Any base: the most a Ring base takes is 6 (Ratcheting).
    assert.ok(check(ring(null, [FIRE, COLD, CHAOS, STUN])).ok);
    assert.deepEqual(
        check(ring(null, [FIRE, COLD, CHAOS, STUN, FIRE, COLD, CHAOS])).problems.some((p) => p.code === 'too-many-suffixes'),
        true,
    );
});

test('any ring base: prefixes and suffixes must fit on one base together', () => {
    // 3 prefixes fit a plain ring and Composite (6 / 0), 4 suffixes fit Helical, Cogwork and Ratcheting, but no ring base takes both.
    const both: PlanCheck = check(ring(null, [LIFE, MANA, RARITY_PREFIX, FIRE, COLD, CHAOS, STUN]));
    assert.deepEqual(
        both.problems.map((p) => [p.code, p.text]),
        [['too-many-affixes', '3 prefix and 4 suffix includes: no Ring base has room for both']],
    );
});

test('3 suffix includes on any ring: the other suffixes stay, since Helical, Cogwork and Ratcheting have room', () => {
    const any: ReadonlyMap<string, readonly [string, string]> = pruned(ring(null, [FIRE, COLD, CHAOS]), [S.sr, S.life]);
    assert.equal(any.has(S.sr), false, 'stun recovery (a suffix) is kept: a 4-suffix base can still roll it');
    // On a plain ring the suffixes are full.
    const iron: ReadonlyMap<string, readonly [string, string]> = pruned(ring('Iron Ring', [FIRE, COLD, CHAOS]), [S.sr]);
    assert.deepEqual(iron.get(S.sr), ['suffixes-full', 'The includes fill all 3 suffixes']);
    // On Helical (4 suffixes) a fourth suffix is still free.
    assert.equal(pruned(ring('Helical Ring', [FIRE, COLD, CHAOS]), [S.sr]).has(S.sr), false);
    // A rarity include needn't take a suffix: rarity also rolls as a prefix, so the suffixes aren't counted full.
    assert.equal(pruned(ring('Iron Ring', [FIRE, COLD, include('suffix', 'ItemFoundRarityIncrease', S.rarity)]), [S.sr]).has(S.sr), false);
});

test('a side the base does not have: its weights go as "can\'t roll", with the reason', () => {
    const r: ReadonlyMap<string, readonly [string, string]> = pruned(ring('Ratcheting Ring', []), [S.life, S.mana, S.fire, S.rarity]);
    assert.deepEqual(r.get(S.life), ['base-cannot-roll', 'Ratcheting Ring has no prefixes']);
    assert.deepEqual(r.get(S.mana), ['base-cannot-roll', 'Ratcheting Ring has no prefixes']);
    assert.equal(r.has(S.fire), false);
    assert.equal(r.has(S.rarity), false, 'rarity is also a suffix, which Ratcheting Ring has');
    // Composite Ring (6 / 0): its suffixes.
    assert.deepEqual(pruned(ring('Composite Ring', []), [S.fire]).get(S.fire), ['base-cannot-roll', 'Composite Ring has no suffixes']);
});

test('the bases the results can be decide the room: 4 suffix includes leave only 4-or-more-suffix rings', () => {
    // Helical (1 prefix) and Cogwork (2 prefixes) and Ratcheting (none) are left: a prefix weight stays.
    const r: ReadonlyMap<string, readonly [string, string]> = pruned(ring(null, [FIRE, COLD, CHAOS, STUN]), [S.life, S.rarity]);
    assert.equal(r.has(S.life), false);
    // With a prefix include too, Ratcheting is out; Helical's one prefix is then full but Cogwork's two are not.
    assert.equal(pruned(ring(null, [LIFE, FIRE, COLD, CHAOS, STUN]), [S.mana]).has(S.mana), false);
    // With two prefix includes only Cogwork (2 / 4) is left, and both its sides are full.
    assert.deepEqual(pruned(ring(null, [LIFE, MANA, FIRE, COLD, CHAOS, STUN]), [S.rarity]).get(S.rarity), [
        'affixes-full',
        'The includes fill every prefix and suffix that could carry it',
    ]);
});

test('the analysed plan: one analysis gives the check, the pruning and the fixed stats', () => {
    const analysed: AnalysedPlan = analysePlan(
        ring('Helical Ring', [{ ...FIRE, stats: [{ statId: S.fire, min: 30 }] }, COLD]),
        'Ring 1',
        ringData(),
    );
    assert.ok(analysed.check.ok);
    assert.deepEqual(analysed.fixedStats(), [{ statId: S.fire, min: 30 }, { statId: S.cold }]);
    assert.deepEqual(
        analysed.view?.bases.map((b) => b.name),
        ['Helical Ring'],
    );
    assert.deepEqual(analysePlan(ring('Ratcheting Ring', [LIFE]), 'Ring 1', ringData()).fixedStats(), [], 'a refused plan fixes nothing');
});
