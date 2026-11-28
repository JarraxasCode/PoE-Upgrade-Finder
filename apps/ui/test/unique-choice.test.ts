import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlotPlan, UniqueChoice } from '@poe-upgrade-finder/vocab';
import { emptySlotPlan } from '@poe-upgrade-finder/vocab';
import { runPlanFor, uniqueItemType } from '../src/slot-plan-model.ts';

const KAOM = { name: "Kaom's Roots", base: 'Titan Greaves', tradeType: 'Titan Greaves' } as const;
const RARE: SlotPlan = { slot: 'Boots', itemType: 'Boots', base: 'Sorcerer Boots', picks: [] };

test('runPlanFor: Rare mode searches the rare plan unchanged, even with a unique stored', () => {
    const choice: UniqueChoice = { mode: 'rare', unique: KAOM };
    assert.equal(runPlanFor('Boots', RARE, choice, 'Boots'), RARE);
    assert.equal(runPlanFor('Boots', RARE, undefined, 'Boots'), RARE);
});

test('runPlanFor: Unique mode searches the picked unique alone, on the item type', () => {
    assert.deepEqual(runPlanFor('Boots', RARE, { mode: 'unique', unique: KAOM }, 'Boots'), {
        slot: 'Boots',
        itemType: 'Boots',
        base: null,
        picks: [],
        unique: KAOM,
    });
});

test('runPlanFor: Unique mode with nothing picked has nothing to search', () => {
    assert.equal(runPlanFor('Boots', RARE, { mode: 'unique', unique: null }, 'Boots'), null);
});

test("uniqueItemType: the plan's type, else the equipped one, never a generic weapon type", () => {
    assert.equal(uniqueItemType('Boots', RARE, 'Boots', null), 'Boots');
    assert.equal(uniqueItemType('Ring 1', emptySlotPlan('Ring 1'), null, null), 'Ring');
    assert.equal(uniqueItemType('Weapon 1', { ...emptySlotPlan('Weapon 1'), itemType: 'One-handed weapon' }, 'Wand', null), 'Wand');
    assert.equal(uniqueItemType('Weapon 1', emptySlotPlan('Weapon 1'), null, null) === 'One-handed weapon', false);
});
