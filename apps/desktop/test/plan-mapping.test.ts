// The slot plan in the Run view's types (issue #6): labels, values and order.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanMatch, SlotSearchSpec } from '@poe-upgrade-finder/core';
import type { UiPlanCheck } from '@poe-upgrade-finder/ipc';
import {
    defenceValue,
    emptyRunCauses,
    hardNeedText,
    levelFilterLabel,
    planChecks,
    planRule,
    socketLabels,
    toUiRunPlan,
} from '../src/run/ui-mapping.ts';
import { emptySlotPlan } from '@poe-upgrade-finder/vocab';
import type { SlotPlan } from '@poe-upgrade-finder/vocab';

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
        sockets: [{ row: 'links', label: 'Links ≥ 6, from plan', value: '6 sockets, 5 linked', status: 'missed' }],
    };
    const checks: UiPlanCheck[] = planChecks(m);
    assert.deepEqual(
        checks.map((c: UiPlanCheck) => [c.kind, c.label, c.value]),
        [
            ['include', '+# total maximum Life (≥ 70)', 'total 71'],
            ['need', 'chaos res ≥ 20', 'total 31'],
            ['exclude', 'rarity', null],
            ['defence', 'Armour (≥ 500)', '418 listed at 0% quality, 502 at 20%'],
            ['socket', 'Links ≥ 6', '6 sockets, 5 linked'],
        ],
    );
    assert.deepEqual(checks[0]?.lines, [
        { text: '+50 to maximum Life', note: '' },
        { text: '+42 to Strength', note: 'crafted, half' },
    ]);
});

test('the header has no plan for an empty one; a hybrid exclude reads as the mod (#38); the level filter reads as searched', () => {
    const spec = {
        baseType: 'Sorcerer Boots',
        requirements: [
            { statId: 'a', origin: 'strip', label: 'Required: chaos res ≥ 20, from strip' },
            { statId: 'b', origin: 'plan', label: 'Required: #% increased Movement Speed (≥ 20), from plan' },
        ],
        exclusions: [{ statId: 'c', origin: 'plan', label: 'Excluded: rarity, from plan' }],
        modExclusions: [
            {
                statIds: ['explicit.stat_1050105434', 'explicit.stat_4052037485'],
                name: '+# to maximum Energy Shield / +# to maximum Mana',
                origin: 'plan',
                label: 'Excluded: +# to maximum Energy Shield / +# to maximum Mana (hybrid mod), from plan',
            },
        ],
        defences: [],
        influences: [],
        pruned: [{ statId: 'd', weight: 1, reason: 'excluded', text: 'excluded' }],
    } as unknown as SlotSearchSpec;
    assert.equal(toUiRunPlan(emptySlotPlan('Boots'), spec, []), null);
    const plan: SlotPlan = { ...emptySlotPlan('Boots'), itemType: 'Boots', base: 'Sorcerer Boots' };
    assert.deepEqual(toUiRunPlan(plan, spec, ['note']), {
        itemType: 'Boots',
        base: 'Sorcerer Boots',
        includes: [{ label: '#% increased Movement Speed (≥ 20)', counts: null }],
        excludes: ['rarity', '+# to maximum Energy Shield / +# to maximum Mana (hybrid mod)'],
        defences: [],
        influences: [],
        pruned: 1,
        notes: ['note'],
    });
    assert.equal(levelFilterLabel({ kind: 'character' }, 92), 'Up to level 92 (your level)');
    assert.equal(levelFilterLabel({ kind: 'max', level: 70 }, 70), 'Up to level 70');
    assert.equal(levelFilterLabel({ kind: 'off' }, undefined), 'Any level');
});

test('socket filter labels for the run header lose their origin; none for no filter', () => {
    assert.deepEqual(
        socketLabels([
            { row: 'sockets', range: { min: 6 }, origin: 'plan', label: 'Sockets ≥ 6, from plan' },
            { row: 'links', range: { r: 3 }, origin: 'plan', label: 'Links 3 R, from plan' },
        ]),
        ['Sockets ≥ 6', 'Links 3 R'],
    );
    assert.deepEqual(socketLabels([]), []);
});

test('a hard need reads without its prefix; a capped one says the gap it came from (#34)', () => {
    const label: string = 'Required: chaos res ≥ 22, from strip';
    const base = { statId: 'pseudo.pseudo_total_chaos_resistance', min: 22, origin: 'strip', label: label } as const;
    assert.equal(hardNeedText(base), 'chaos res ≥ 22');
    assert.equal(
        hardNeedText({ ...base, gap: 44 }),
        'chaos res ≥ 22 (without this item the build is 44 short of the floor, more than the item carries itself)',
    );
});

test('an empty run lists what narrowed its search, in the order the header shows it (#34)', () => {
    const spec = {
        listingType: 'securable',
        unique: null,
        baseType: 'Sorcerer Boots',
        requirements: [
            { statId: 'b', origin: 'plan', label: 'Required: #% increased Movement Speed (≥ 20), from plan' },
            { statId: 'a', origin: 'strip', min: 22, gap: 44, label: 'Required: chaos res ≥ 22, from strip' },
        ],
        defences: [{ label: 'Energy Shield (≥ 100), from plan' }],
        sockets: [{ label: 'Links ≥ 6, from plan' }],
        influences: ['adjudicator', 'eyrie'],
        maxLevelRequirement: 68,
    } as unknown as SlotSearchSpec;
    assert.deepEqual(emptyRunCauses(spec), [
        'chaos res ≥ 22 (without this item the build is 44 short of the floor, more than the item carries itself), from a floor in Settings',
        '#% increased Movement Speed (≥ 20)',
        'Energy Shield (≥ 100)',
        'Links ≥ 6',
        'base Sorcerer Boots',
        'Warlord and Redeemer influence',
        'up to level 68',
    ]);
    const unique = {
        ...spec,
        listingType: 'online',
        baseType: null,
        requirements: [],
        defences: [],
        sockets: [],
        influences: [],
        maxLevelRequirement: undefined,
        unique: { name: "Kaom's Roots" },
    };
    assert.deepEqual(emptyRunCauses(unique as unknown as SlotSearchSpec), ["the unique Kaom's Roots"]);
});
