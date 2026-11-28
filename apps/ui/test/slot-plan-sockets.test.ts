// The slot plan's socket filters in the editor (#58): edits, the summary chips, emptiness, and unique runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanSockets, SlotPlan } from '@poe-upgrade-finder/vocab';
import { emptySlotPlan } from '@poe-upgrade-finder/vocab';
import {
    isBlankPlan,
    parseSocketValue,
    runPlanFor,
    socketRowFromTexts,
    socketSummaryParts,
    withItemType,
    withSocket,
    withSocketRow,
} from '../src/slot-plan-model.ts';

const KAOM = { name: "Kaom's Roots", base: 'Titan Greaves', tradeType: 'Titan Greaves' } as const;
const SIX_LINK: PlanSockets = { links: { min: 6, max: 6 } };

test('withSocket sets one field; a row with nothing left goes, and so does the filter', () => {
    const one: SlotPlan = withSocket(emptySlotPlan('Body Armour'), 'links', 'min', 6);
    const both: SlotPlan = withSocket(one, 'links', 'max', 6);
    assert.deepEqual(both.sockets, SIX_LINK);
    const red: SlotPlan = withSocket(both, 'sockets', 'r', 3);
    assert.deepEqual(red.sockets, { links: { min: 6, max: 6 }, sockets: { r: 3 } });
    const cleared: SlotPlan = withSocket(withSocket(withSocket(red, 'links', 'min', null), 'links', 'max', null), 'sockets', 'r', null);
    assert.equal('sockets' in cleared, false);
    // Sockets need no item type: setting one doesn't name it.
    assert.equal(both.itemType, null);
});

test('changing the item type keeps the socket filters', () => {
    const p: SlotPlan = { ...emptySlotPlan('Body Armour'), sockets: SIX_LINK };
    assert.deepEqual(withItemType(p, 'Body Armour', null).sockets, SIX_LINK);
});

test('a plan with only socket filters is not blank', () => {
    assert.equal(isBlankPlan({ ...emptySlotPlan('Boots'), sockets: SIX_LINK }), false);
    assert.equal(isBlankPlan(emptySlotPlan('Boots')), true);
});

test('socket summary chips: range, then colours', () => {
    const p: SlotPlan = { ...emptySlotPlan('Body Armour'), sockets: { sockets: { min: 6, max: 6 }, links: { min: 5, r: 3 } } };
    assert.deepEqual(socketSummaryParts(p), ['Sockets 6', 'Links ≥ 5, 3 R']);
    assert.deepEqual(socketSummaryParts(emptySlotPlan('Boots')), []);
});

test("a unique run carries the slot's socket filters", () => {
    const rare: SlotPlan = { slot: 'Boots', itemType: 'Boots', base: 'Sorcerer Boots', picks: [], sockets: SIX_LINK };
    assert.deepEqual(runPlanFor('Boots', rare, { mode: 'unique', unique: KAOM }, 'Boots'), {
        slot: 'Boots',
        itemType: 'Boots',
        base: null,
        picks: [],
        unique: KAOM,
        sockets: SIX_LINK,
    });
});

test('socket values: empty is no limit, 0 to 6 a value, anything else refused', () => {
    assert.equal(parseSocketValue(''), null);
    assert.equal(parseSocketValue(' 6 '), 6);
    assert.equal(parseSocketValue('0'), 0);
    assert.equal(parseSocketValue('7'), undefined);
    assert.equal(parseSocketValue('x'), undefined);
    assert.equal(parseSocketValue('1.5'), undefined);
});

test('socketRowFromTexts: a row saves only when every box reads and min is not above max', () => {
    const texts = { r: '', g: '', b: '', w: '', min: '6', max: '6' };
    assert.deepEqual(socketRowFromTexts(texts), { ok: true, range: { min: 6, max: 6 } });
    assert.deepEqual(socketRowFromTexts({ ...texts, max: '5' }), { ok: false, problem: 'The min is above the max.' });
    assert.deepEqual(socketRowFromTexts({ ...texts, r: '7' }), {
        ok: false,
        problem: 'Type a whole number from 0 to 6, or leave it empty.',
    });
    assert.deepEqual(socketRowFromTexts({ r: '3', g: '', b: '', w: '', min: '', max: '' }), { ok: true, range: { r: 3 } });
});

test('withSocketRow replaces a row; an empty row goes', () => {
    const p: SlotPlan = withSocketRow(emptySlotPlan('Body Armour'), 'links', { min: 5, max: 5 });
    assert.deepEqual(withSocketRow(p, 'links', { min: 6, max: 6 }).sockets, SIX_LINK);
    assert.equal('sockets' in withSocketRow(p, 'links', {}), false);
});
