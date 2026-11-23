import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EquippedItem, PobItemView } from '@poe-upgrade-finder/engine-client';
import { baseArt, itemArt, readBaseArt } from '../src/services/base-art.ts';
import { equippedInfo } from '../src/services/build-summary.ts';

test('the committed table maps bases to unsigned CDN images', () => {
    assert.deepEqual(baseArt("Assassin's Boots"), {
        icon: 'https://web.poecdn.com/image/Art/2DItems/Armours/Boots/BootsDexInt3.png',
        width: 2,
        height: 2,
    });
    assert.equal(baseArt('Vaal Regalia')?.height, 3);
    assert.equal(baseArt('No Such Base'), undefined);
});

test('a unique gets its own art (Foulborn variants too); an unknown one falls back to its base', () => {
    assert.equal(
        itemArt('Void Sceptre', 'Nebulis')?.icon,
        'https://web.poecdn.com/image/Art/2DItems/Weapons/OneHandWeapons/Scepters/SceptreOfMemories.png',
    );
    assert.equal(itemArt('Void Sceptre', 'Nebulis')?.height, 4);
    assert.equal(
        itemArt('Cutlass', 'Foulborn Severed in Sleep')?.icon,
        'https://web.poecdn.com/image/Art/2DItems/Weapons/OneHandWeapons/OneHandSwords/EternalSleep1.png',
    );
    assert.deepEqual(itemArt('Void Sceptre', 'Not A Unique'), baseArt('Void Sceptre'));
    assert.deepEqual(itemArt('Void Sceptre', null), baseArt('Void Sceptre'));
});

test('entries that are not [path, width, height] are skipped', () => {
    const t = readBaseArt({ A: ['Rings/Ring1', 1, 1], B: ['../evil', 1, 1], C: ['Rings/Ring2', 0, 1], D: 'x' });
    assert.deepEqual([...t.keys()], ['A']);
});

const VIEW: PobItemView = {
    rarity: 'rare',
    name: 'Corruption Stride',
    typeLine: 'Leviathan Greaves',
    baseName: 'Leviathan Greaves',
    influences: ['searing'],
    properties: [],
    requirements: [],
    sockets: 'R-W',
    itemLevel: 85,
    enchants: [],
    implicits: [],
    explicits: [{ text: '+122 to maximum Life', kind: 'explicit' }],
    corrupted: false,
    mirrored: false,
};

test('an equipped item gets its base image added to PoB view', () => {
    const e: EquippedItem = {
        slot: 'Boots',
        name: 'Corruption Stride, Leviathan Greaves',
        base: 'Leviathan Greaves',
        rarity: 'RARE',
        type: 'Boots',
        text: '',
        view: VIEW,
    };
    const asked: (string | null)[] = [];
    const info = equippedInfo(e, (_base: string, unique: string | null) => {
        asked.push(unique);
        return { icon: 'https://web.poecdn.com/image/Art/2DItems/Armours/Boots/BootsStr4.png', width: 2, height: 2 };
    });
    assert.deepEqual([...asked], [null], 'a rare is looked up by base only');
    equippedInfo({ ...e, view: { ...VIEW, rarity: 'unique', name: 'Nebulis' } }, (_base: string, unique: string | null) => {
        asked.push(unique);
        return undefined;
    });
    assert.deepEqual(asked, [null, 'Nebulis']);
    assert.equal(info.view?.icon, 'https://web.poecdn.com/image/Art/2DItems/Armours/Boots/BootsStr4.png');
    assert.equal(info.view?.typeLine, 'Leviathan Greaves');
    assert.equal(equippedInfo(e, () => undefined).view?.icon, null);
    assert.equal(equippedInfo({ ...e, view: undefined }, () => undefined).view, null);
});
