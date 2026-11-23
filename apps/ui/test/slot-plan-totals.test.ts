// The editor's side of issue #26: pseudo totals as their own picks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModPick, SlotPlan, TotalOption } from '@poe-upgrade-finder/ipc';
import { listTotals, totalsOf, withItemType, withoutTotal, withPick, withTotal, withTotalRange } from '../src/slot-plan-model.ts';

const LIFE: TotalOption = { id: 'pseudo.pseudo_total_life', text: '+# total maximum Life', counts: "half of the item's Strength" };
const DEX: TotalOption = { id: 'pseudo.pseudo_total_dexterity', text: '+# total to Dexterity', counts: '+all Attributes' };
const EMPTY: TotalOption = { id: 'pseudo.pseudo_number_of_empty_prefix_mods', text: '# Empty Prefix Modifiers', counts: null };
const OPTIONS: readonly TotalOption[] = [LIFE, DEX, EMPTY];

const BARE: SlotPlan = { slot: 'Amulet', itemType: null, base: null, picks: [] };

test('adding a total names the item type; removing the last one goes back to an empty plan', () => {
    const one: SlotPlan = withTotal(BARE, LIFE, 'Amulet', 'Amulet');
    assert.equal(one.itemType, 'Amulet');
    assert.deepEqual(totalsOf(one), [{ statId: LIFE.id, text: LIFE.text }]);
    assert.equal(withTotal(one, LIFE, 'Amulet', 'Amulet'), one, 'once only');
    assert.deepEqual(withoutTotal(one, LIFE.id, 'Amulet', 'Amulet'), { ...BARE });
});

test('a range on a total: either end, null clears it', () => {
    const one: SlotPlan = withTotal(BARE, LIFE, 'Amulet', 'Amulet');
    const ranged: SlotPlan = withTotalRange(one, LIFE.id, 'min', 80, 'Amulet', 'Amulet');
    assert.deepEqual(totalsOf(ranged), [{ statId: LIFE.id, text: LIFE.text, min: 80 }]);
    const both: SlotPlan = withTotalRange(ranged, LIFE.id, 'max', 120, 'Amulet', 'Amulet');
    assert.deepEqual(totalsOf(withTotalRange(both, LIFE.id, 'min', null, 'Amulet', 'Amulet')), [
        { statId: LIFE.id, text: LIFE.text, max: 120 },
    ]);
});

test('the picker lists every total not in the plan, best match first; all of them with no query', () => {
    const one: SlotPlan = withTotal(BARE, LIFE, 'Amulet', 'Amulet');
    assert.deepEqual(listTotals(OPTIONS, BARE, ''), OPTIONS);
    assert.deepEqual(
        listTotals(OPTIONS, one, '').map((o) => o.id),
        [DEX.id, EMPTY.id],
    );
    assert.deepEqual(
        listTotals(OPTIONS, BARE, 'dex').map((o) => o.id),
        [DEX.id],
    );
    assert.deepEqual(listTotals(OPTIONS, BARE, 'pseudo').length, 3, 'searchable as "pseudo" too');
});

test('totals stay when the item type changes; mods go', () => {
    const pick: ModPick = {
        position: 'suffix',
        group: 'Dexterity',
        influence: 'none',
        rule: 'include',
        stats: [{ statId: 'explicit.stat_1' }],
    };
    const plan: SlotPlan = withPick(withTotal(BARE, DEX, 'Amulet', 'Amulet'), null, pick, 'Amulet');
    const changed: SlotPlan = withItemType(plan, 'Ring', 'Amulet');
    assert.deepEqual(changed.picks, []);
    assert.deepEqual(totalsOf(changed), [{ statId: DEX.id, text: DEX.text }]);
});
