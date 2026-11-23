// The editor's Defences row (issue #24): which defences show, the base hints, typed values and the plan edits.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptySlotPlan } from '@poe-upgrade-finder/ipc';
import type { BaseOption, SlotEditorData, SlotPlan } from '@poe-upgrade-finder/ipc';
import {
    defenceKindsOf,
    defencesSummary,
    parseDefence,
    setDefences,
    withDefence,
    withItemType,
    withoutPicks,
} from '../src/slot-plan-model.ts';

function base(name: string, defences: BaseOption['defences']): BaseOption {
    return { name: name, tradeType: name, level: 60, defences: defences, implicits: [], influences: [], icon: null };
}

const BOOTS: SlotEditorData = {
    pobVersion: '2.68.1',
    slot: 'Boots',
    itemType: 'Boots',
    base: null,
    bases: [
        base('Sorcerer Boots', { energyShield: [42, 51] }),
        base('Slink Boots', { evasion: [228, 262] }),
        base('Two-Toned Boots (Armour/Evasion)', { armour: [126, 145], evasion: [126, 145] }),
    ],
    mods: [],
    totals: [],
};

test('the row shows the defences some base has; a type without any shows none', () => {
    assert.deepEqual(defenceKindsOf(BOOTS), ['armour', 'evasion', 'energyShield']);
    assert.deepEqual(defenceKindsOf({ ...BOOTS, itemType: 'Quiver', bases: [base('Serrated Arrow Quiver', {})] }), []);
});

test('defence values are whole numbers from 0; empty is no limit', () => {
    assert.equal(parseDefence(''), null);
    assert.equal(parseDefence(' 0 '), 0);
    assert.equal(parseDefence('400'), 400);
    assert.equal(parseDefence('1.5'), undefined);
    assert.equal(parseDefence('-1'), undefined);
    assert.equal(parseDefence('lots'), undefined);
});

test('setting a defence names the item type; clearing every end leaves an empty plan', () => {
    const empty: SlotPlan = emptySlotPlan('Boots');
    const pure: SlotPlan = withDefence(
        withDefence(empty, 'energyShield', 'max', 0, 'Boots', 'Boots'),
        'evasion',
        'max',
        0,
        'Boots',
        'Boots',
    );
    assert.equal(pure.itemType, 'Boots');
    assert.deepEqual(pure.defences, { energyShield: { max: 0 }, evasion: { max: 0 } });
    assert.equal(defencesSummary(pure), 'Evasion ≤ 0, Energy Shield ≤ 0');

    const ranged: SlotPlan = withDefence(withDefence(pure, 'armour', 'min', 300, 'Boots', 'Boots'), 'armour', 'max', 600, 'Boots', 'Boots');
    assert.deepEqual(ranged.defences?.armour, { min: 300, max: 600 });
    assert.match(defencesSummary(ranged) ?? '', /^Armour 300 to 600/);

    let cleared: SlotPlan = withDefence(pure, 'energyShield', 'max', null, 'Boots', 'Boots');
    cleared = withDefence(cleared, 'evasion', 'max', null, 'Boots', 'Boots');
    assert.deepEqual(cleared, emptySlotPlan('Boots'));
    assert.equal(setDefences(cleared).length, 0);
});

test('clearing mods keeps the defences; changing the item type drops them', () => {
    const shield: SlotPlan = withDefence(emptySlotPlan('Weapon 2'), 'energyShield', 'min', 100, 'Shield', 'Wand');
    assert.deepEqual(withoutPicks(shield, 'Shield', 'Wand').defences, { energyShield: { min: 100 } });
    assert.equal(withItemType(shield, 'Quiver', 'Wand').defences, undefined);
});
