import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchRequirement } from '@poe-upgrade-finder/core';
import type { EquippedItem, TradeQueryData, UniqueInfo, UniquesData } from '@poe-upgrade-finder/engine-client';
import { pickedUnique, uniqueNotes, uniqueRunQuery } from '../src/run/unique-run.ts';

const LIFE: string = 'explicit.stat_3299347043';

function kaom(): UniqueInfo {
    return {
        name: "Kaom's Roots",
        base: 'Titan Greaves',
        tradeType: 'Titan Greaves',
        variant: 2,
        variants: 2,
        scoreLow: 1,
        scoreMid: 1,
        scoreHigh: 1,
        change: -78,
        weights: [{ id: LIFE, weight: 0.33, line: '+(150-200) to maximum Life' }],
        rolls: [],
        statIds: [LIFE],
        unmatched: [],
        foulborn: null,
    };
}

const DATA: UniquesData = { slot: 'Boots', itemType: 'Boots', target: { kind: 'fullDps', saved: true }, uniques: [kaom()] };

test('pickedUnique finds the picked unique by name, or says PoB has no such unique', () => {
    assert.equal(pickedUnique(DATA, { name: "Kaom's Roots", base: 'Titan Greaves', tradeType: 'Titan Greaves' }).name, "Kaom's Roots");
    assert.throws(
        () => pickedUnique(DATA, { name: 'Nope', base: 'Titan Greaves', tradeType: 'Titan Greaves' }),
        /PoB has no unique named Nope \(Titan Greaves\) for Boots/,
    );
});

test('uniqueNotes: one line per hard need the unique has no line for', () => {
    const fire: SearchRequirement = {
        statId: 'pseudo.pseudo_total_fire_resistance',
        min: 30,
        origin: 'strip',
        label: 'Required: fire res ≥ 30, from strip',
    };
    const life: SearchRequirement = {
        statId: 'pseudo.pseudo_total_life',
        min: 40,
        origin: 'strip',
        label: 'Required: life ≥ 40, from strip',
    };
    assert.deepEqual(uniqueNotes(kaom(), [fire, life]), [
        "Kaom's Roots has no line for Required: fire res ≥ 30, from strip: only copies that get it from a corruption or an enchant can pass.",
    ]);
    assert.deepEqual(uniqueNotes(kaom(), [life]), []);
});

test("uniqueRunQuery: the slot's item for the header and the unique's category, with no generator weights", () => {
    const boots: EquippedItem = {
        slot: 'Boots',
        name: 'Corruption Stride',
        base: 'Leviathan Greaves',
        rarity: 'RARE',
        type: 'Boots',
        text: 'Rarity: RARE',
        view: undefined,
    };
    const q: TradeQueryData = uniqueRunQuery('Boots', 'Boots', DATA, [boots]);
    assert.equal(q.item.name, 'Corruption Stride');
    assert.equal(q.category.query, 'armour.boots');
    assert.deepEqual(q.weights, []);
    assert.deepEqual(q.query.stats, []);
    assert.equal(uniqueRunQuery('Boots', 'Boots', DATA, []).item.rarity, 'NONE');
});

test('pickedUnique: a name shared by several bases is matched on the base too', () => {
    const doryani = (base: string): UniqueInfo => ({ ...kaom(), name: "Doryani's Delusion", base: base, tradeType: base });
    const data: UniquesData = { ...DATA, uniques: [doryani('Leviathan Greaves'), doryani('Warlock Boots'), doryani('Velour Boots')] };
    assert.equal(
        pickedUnique(data, { name: "Doryani's Delusion", base: 'Warlock Boots', tradeType: 'Warlock Boots' }).base,
        'Warlock Boots',
    );
    assert.throws(
        () => pickedUnique(data, { name: "Doryani's Delusion", base: 'Titan Greaves', tradeType: 'Titan Greaves' }),
        /PoB has no unique/,
    );
});

test('pickedUnique: the unique and each Foulborn version are told apart by the mutated mod (pob-internals P31)', () => {
    const foul: UniqueInfo = {
        ...kaom(),
        foulborn: { modId: 'MutatedUniqueBootsStr2Strength', line: '+(150-200) to Strength', statId: 'explicit.stat_4080418644' },
    };
    const data: UniquesData = { ...DATA, uniques: [kaom(), foul] };
    const pick = { name: "Kaom's Roots", base: 'Titan Greaves', tradeType: 'Titan Greaves' } as const;
    assert.equal(pickedUnique(data, pick).foulborn, null);
    assert.equal(
        pickedUnique(data, { ...pick, foulborn: 'MutatedUniqueBootsStr2Strength' }).foulborn?.modId,
        'MutatedUniqueBootsStr2Strength',
    );
    assert.throws(() => pickedUnique(data, { ...pick, foulborn: 'MutatedGone' }), /Foulborn Kaom's Roots/);
});
