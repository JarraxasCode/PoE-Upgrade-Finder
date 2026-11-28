import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FLOORS, floorChecks, stripNeeds } from '../src/floors.ts';
import type { CheckResult, ItemCheck, SearchRequirement } from '../src/spec.ts';
import { baseStats } from './fixtures.ts';

function results(after: ReturnType<typeof baseStats>, before: ReturnType<typeof baseStats> = baseStats()): Map<string, CheckResult> {
    return new Map<string, CheckResult>(floorChecks(DEFAULT_FLOORS, 'Boots').map((c: ItemCheck) => [c.id, c.evaluate(before, after)]));
}

test('the default checks: floors, targets and flags with their ids', () => {
    const ids: string[] = floorChecks(DEFAULT_FLOORS, 'Boots').map((c: ItemCheck) => c.id);
    assert.deepEqual(ids, [
        'chaos-res',
        'max-res-fire',
        'res-capped-fire',
        'res-capped-cold',
        'res-capped-lightning',
        'spell-block',
        'attr-str',
        'attr-dex',
        'attr-int',
        'target-chaos-res',
        'target-max-res-fire',
        'target-overcap-fire',
        'target-overcap-cold',
        'target-overcap-lightning',
        'life-loss',
        'net-regen',
    ]);
    assert.ok(!floorChecks(DEFAULT_FLOORS, 'Weapon 1').some((c: ItemCheck) => c.id === 'life-loss'), 'no life-loss flag on weapons');
});

test('an item keeping everything passes every floor and raises no flag', () => {
    for (const c of floorChecks(DEFAULT_FLOORS, 'Boots')) {
        if (c.kind !== 'target') {
            assert.notEqual(c.evaluate(baseStats(), baseStats()).status, 'fail', c.id);
        }
    }
});

test('floors fail on the item that breaks them', () => {
    const r: Map<string, CheckResult> = results(
        baseStats({ ChaosResist: 47, ColdResist: 70, MissingColdResist: 5, SpellBlockChance: 74, Dex: 90 }),
    );
    assert.equal(r.get('chaos-res')?.status, 'fail');
    assert.equal(r.get('chaos-res')?.detail, 'Chaos res ≥ 50: 47 (was 75)');
    assert.equal(r.get('res-capped-cold')?.status, 'fail');
    assert.equal(r.get('res-capped-fire')?.status, 'pass');
    assert.equal(r.get('spell-block')?.status, 'fail');
    assert.equal(r.get('attr-dex')?.status, 'fail');
    assert.equal(r.get('attr-str')?.status, 'pass');
});

test('max fire res reads FireResist + MissingFireResist', () => {
    assert.equal(results(baseStats({ FireResist: 87, MissingFireResist: 0 })).get('max-res-fire')?.status, 'fail');
    // Uncapped at 87 of a max of 88 still has max res 88.
    assert.equal(results(baseStats({ FireResist: 87, MissingFireResist: 1 })).get('max-res-fire')?.status, 'pass');
});

test('a floor the build already fails is skipped, not failed', () => {
    const before = baseStats({ SpellBlockChance: 0, FireResist: 75, MissingFireResist: 0 });
    const r: Map<string, CheckResult> = results(baseStats({ SpellBlockChance: 0, FireResist: 75, MissingFireResist: 0 }), before);
    assert.equal(r.get('spell-block')?.status, 'skipped');
    assert.match(r.get('spell-block')?.detail ?? '', /already below/);
    assert.equal(r.get('max-res-fire')?.status, 'skipped');
});

test('targets and flags', () => {
    const r: Map<string, CheckResult> = results(baseStats({ ChaosResist: 70, FireResistOverCap: 5, Life: 6900, NetLifeRegen: -10 }));
    assert.equal(r.get('target-chaos-res')?.status, 'fail');
    assert.equal(r.get('target-max-res-fire')?.status, 'fail'); // 89 < 90
    assert.equal(r.get('target-overcap-fire')?.status, 'fail');
    assert.equal(r.get('target-overcap-cold')?.status, 'pass');
    assert.equal(r.get('life-loss')?.status, 'fail');
    assert.equal(r.get('net-regen')?.status, 'fail');
    assert.equal(results(baseStats()).get('net-regen')?.status, 'skipped', 'no NetLifeRegen key: no degen');
});

test('strip needs: a floor that passes before and fails after the strip becomes min = floor − uncapped total', () => {
    const baseline = baseStats();
    const stripped = baseStats({
        ChaosResist: 31,
        ChaosResistTotal: 31.5,
        ColdResist: 59,
        MissingColdResist: 16,
        ColdResistTotal: 59, // max 75
        Dex: 80,
        ReqDex: 98,
    });
    const needs: SearchRequirement[] = stripNeeds(DEFAULT_FLOORS, baseline, stripped);
    assert.deepEqual(needs, [
        { statId: 'pseudo.pseudo_total_chaos_resistance', min: 19, origin: 'strip', label: 'Required: chaos res ≥ 19, from strip' },
        { statId: 'pseudo.pseudo_total_cold_resistance', min: 16, origin: 'strip', label: 'Required: cold res ≥ 16, from strip' },
        { statId: 'pseudo.pseudo_total_dexterity', min: 18, origin: 'strip', label: 'Required: dexterity ≥ 18, from strip' },
    ]);
});

test('strip needs: nothing when the strip keeps the floors, or the floor already failed', () => {
    assert.deepEqual(stripNeeds(DEFAULT_FLOORS, baseStats(), baseStats({ ChaosResist: 51, ChaosResistTotal: 51 })), []);
    // Chaos already under 50 with the item on: stays soft.
    assert.deepEqual(stripNeeds(DEFAULT_FLOORS, baseStats({ ChaosResist: 40 }), baseStats({ ChaosResist: 20, ChaosResistTotal: 20 })), []);
    // Cold already uncapped with the item on: stays soft.
    assert.deepEqual(
        stripNeeds(
            DEFAULT_FLOORS,
            baseStats({ ColdResist: 70, MissingColdResist: 5 }),
            baseStats({ ColdResist: 50, MissingColdResist: 25, ColdResistTotal: 50 }),
        ),
        [],
    );
});

// #34: the gap is in the build's total, the filter on the item's own; scaling on the build can make the gap
// bigger than any item. Capped at what the current item carries, an item like it always meets the need.
const CHAOS_GAP = baseStats({ ChaosResist: 6, ChaosResistTotal: 6 }); // floor 50: gap 44

test('strip needs: capped at the item own total, with the gap kept', () => {
    assert.deepEqual(stripNeeds(DEFAULT_FLOORS, baseStats(), CHAOS_GAP, { Chaos: 22 }), [
        {
            statId: 'pseudo.pseudo_total_chaos_resistance',
            min: 22,
            gap: 44,
            origin: 'strip',
            label: 'Required: chaos res ≥ 22, from strip',
        },
    ]);
});

test('strip needs: a need under the item own total is not capped', () => {
    assert.deepEqual(stripNeeds(DEFAULT_FLOORS, baseStats(), CHAOS_GAP, { Chaos: 60 }), [
        { statId: 'pseudo.pseudo_total_chaos_resistance', min: 44, origin: 'strip', label: 'Required: chaos res ≥ 44, from strip' },
    ]);
});

test('strip needs: dropped when the item carries none of it', () => {
    const stripped = baseStats({
        ChaosResist: 6,
        ChaosResistTotal: 6,
        ColdResist: 59,
        MissingColdResist: 16,
        ColdResistTotal: 59,
        Str: 80,
        ReqStr: 98,
    });
    assert.deepEqual(stripNeeds(DEFAULT_FLOORS, baseStats(), stripped, { Chaos: 0, Cold: 0, Str: -5 }), []);
});

test('strip needs: a total the item has no key for leaves the need as it was', () => {
    assert.deepEqual(stripNeeds(DEFAULT_FLOORS, baseStats(), CHAOS_GAP, { Fire: 10 }), [
        { statId: 'pseudo.pseudo_total_chaos_resistance', min: 44, origin: 'strip', label: 'Required: chaos res ≥ 44, from strip' },
    ]);
});
