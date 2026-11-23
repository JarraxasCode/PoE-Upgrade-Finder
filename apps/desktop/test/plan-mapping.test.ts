// The slot plan in the Run view's types (issue #6): labels, values and order.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPlan } from '@poe-upgrade-finder/core';
import type { PlanMatch, SlotPlan, SlotSearchSpec } from '@poe-upgrade-finder/core';
import type { UiPlanCheck } from '@poe-upgrade-finder/ipc';
import { defenceValue, levelFilterLabel, planChecks, planRule, toUiRunPlan } from '../src/run/ui-mapping.ts';

test('spec labels lose their prefix and origin; a total keeps what it counts apart', () => {
    assert.deepEqual(planRule('Required: +# total to Dexterity (≥ 30) (counts implicits, +all Attributes), from plan'), {
        label: '+# total to Dexterity (≥ 30)',
        counts: 'implicits, +all Attributes',
    });
    assert.deepEqual(planRule('Excluded: #% increased Rarity of Items found, from plan'), {
        label: '#% increased Rarity of Items found',
        counts: null,
    });
    assert.deepEqual(planRule('Energy Shield (≤ 0), from plan'), { label: 'Energy Shield (≤ 0)', counts: null });
});

test("defence values say the site's 20% quality rule when it raises one", () => {
    assert.equal(defenceValue({ listed: 418, quality: 0, compared: 501.6 }), '418 listed at 0% quality, 502 at 20%');
    assert.equal(defenceValue({ listed: 600, quality: 20, compared: 600 }), '600 at 20% quality');
    assert.equal(defenceValue({ listed: 0, quality: 18, compared: 0 }), 'none on the item');
    assert.equal(defenceValue({ listed: null, quality: 0, compared: null }), null);
});

test('plan checks: includes, then the build needs, excludes and defences; lines say their kind and factor', () => {
    const m: PlanMatch = {
        requirements: [
            {
                statId: 'pseudo.pseudo_total_chaos_resistance',
                origin: 'strip',
                label: 'Required: chaos res ≥ 20, from strip',
                min: 20,
                total: 31,
                status: 'met',
                lines: [],
            },
            {
                statId: 'pseudo.pseudo_total_life',
                origin: 'plan',
                label: 'Required: +# total maximum Life (≥ 70) (counts implicits), from plan',
                min: 70,
                total: 71,
                status: 'met',
                lines: [
                    { text: '+50 to maximum Life', kind: 'explicit', value: 50, factor: 1 },
                    { text: '+42 to Strength', kind: 'crafted', value: 42, factor: 0.5 },
                ],
            },
        ],
        exclusions: [{ statId: 'explicit.stat_1', label: 'Excluded: rarity, from plan', status: 'met', lines: [] }],
        defences: [
            {
                defence: 'armour',
                label: 'Armour (≥ 500), from plan',
                min: 500,
                listed: 418,
                quality: 0,
                compared: 501.6,
                status: 'met',
            },
        ],
    };
    const checks: UiPlanCheck[] = planChecks(m);
    assert.deepEqual(
        checks.map((c: UiPlanCheck) => [c.kind, c.label, c.value]),
        [
            ['include', '+# total maximum Life (≥ 70)', 'total 71'],
            ['need', 'chaos res ≥ 20', 'total 31'],
            ['exclude', 'rarity', null],
            ['defence', 'Armour (≥ 500)', '418 listed at 0% quality, 502 at 20%'],
        ],
    );
    assert.deepEqual(checks[0]?.lines, [
        { text: '+50 to maximum Life', note: '' },
        { text: '+42 to Strength', note: 'crafted, half' },
    ]);
});

test('the header has no plan for an empty one; the level filter reads as searched', () => {
    const spec = {
        baseType: 'Sorcerer Boots',
        requirements: [
            { statId: 'a', origin: 'strip', label: 'Required: chaos res ≥ 20, from strip' },
            { statId: 'b', origin: 'plan', label: 'Required: #% increased Movement Speed (≥ 20), from plan' },
        ],
        exclusions: [{ statId: 'c', origin: 'plan', label: 'Excluded: rarity, from plan' }],
        defences: [],
        influences: [],
        pruned: [{ statId: 'd', weight: 1, reason: 'excluded', text: 'excluded' }],
    } as unknown as SlotSearchSpec;
    assert.equal(toUiRunPlan(emptyPlan('Boots'), spec, []), null);
    const plan: SlotPlan = { ...emptyPlan('Boots'), itemType: 'Boots', base: 'Sorcerer Boots' };
    assert.deepEqual(toUiRunPlan(plan, spec, ['note']), {
        itemType: 'Boots',
        base: 'Sorcerer Boots',
        includes: [{ label: '#% increased Movement Speed (≥ 20)', counts: null }],
        excludes: ['rarity'],
        defences: [],
        influences: [],
        pruned: 1,
        notes: ['note'],
    });
    assert.equal(levelFilterLabel({ kind: 'character' }, 92), 'Up to level 92 (your level)');
    assert.equal(levelFilterLabel({ kind: 'max', level: 70 }, 70), 'Up to level 70');
    assert.equal(levelFilterLabel({ kind: 'off' }, undefined), 'Any level');
});
