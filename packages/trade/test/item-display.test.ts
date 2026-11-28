import assert from 'node:assert/strict';
import { test } from 'node:test';
import { propertyLine, readItemDisplay, stripMarkup } from '../src/item-display.ts';
import type { ItemLine, ItemView } from '@poe-upgrade-finder/vocab';

const ICON: string = 'https://web.poecdn.com/gen/image/abc/0c80b843d0/BootsDexInt3.png';

/** Shaped like a signed-in fetch's item (V19 recording), trimmed. */
const BOOTS: unknown = {
    w: 2,
    h: 2,
    icon: ICON,
    name: 'Mind March',
    typeLine: "Assassin's Boots",
    baseType: "Assassin's Boots",
    rarity: 'Rare',
    ilvl: 85,
    sockets: [
        { group: 0, sColour: 'W' },
        { group: 0, sColour: 'B' },
        { group: 1, sColour: 'B' },
    ],
    properties: [
        { name: 'Quality', values: [['+20%', 1]], displayMode: 0 },
        { name: 'Evasion Rating', values: [['233', 1]], displayMode: 0 },
        { name: 'Experience', values: [['1/10', 0]], displayMode: 2 },
    ],
    requirements: [
        { name: 'Level', values: [['64', 0]], displayMode: 0 },
        { name: 'Dex', values: [['62', 0]], displayMode: 1 },
    ],
    implicitMods: [{ description: '+19% to Fire and Lightning Resistances', domain: 'implicit' }],
    explicitMods: [
        { description: '70% increased Evasion and Energy Shield', domain: 'explicit' },
        { description: '+116 to maximum Life', domain: 'fractured', flags: { fractured: true } },
        { description: '8% chance to gain [Onslaught] for 4 seconds on Kill', domain: 'crafted', flags: { crafted: true } },
    ],
    influences: { elder: true },
    elder: true,
    corrupted: true,
    frameType: 2,
};

const text = (line: ItemLine): string => line.map((p) => p.text).join('');

test('reads a signed-in fetch item into tooltip data', () => {
    const d: ItemView = readItemDisplay(BOOTS);
    assert.equal(d.icon, ICON);
    assert.deepEqual([d.width, d.height, d.rarity, d.name, d.typeLine, d.itemLevel], [2, 2, 'rare', 'Mind March', "Assassin's Boots", 85]);
    assert.deepEqual(d.influences, ['elder']);
    assert.deepEqual(d.properties.map(text), ['Quality: +20%', 'Evasion Rating: 233']);
    assert.equal(d.properties[1]?.[1]?.tone, 'augmented');
    assert.equal(text(d.requirements), 'Requires Level 64, Dex 62');
    assert.equal(d.sockets, 'W-B B');
    assert.deepEqual(d.implicits, [{ text: '+19% to Fire and Lightning Resistances', kind: 'implicit' }]);
    assert.deepEqual(
        d.explicits.map((m) => m.kind),
        ['explicit', 'fractured', 'crafted'],
    );
    assert.equal(d.explicits[2]?.text, '8% chance to gain Onslaught for 4 seconds on Kill');
    assert.equal(d.corrupted, true);
});

test('accepts the public API shape: mods as strings, separate crafted and fractured groups', () => {
    const d: ItemView = readItemDisplay({
        frameType: 2,
        name: 'X',
        typeLine: 'Iron Ring',
        explicitMods: ['+10 to Strength'],
        craftedMods: ['+5 to Dexterity'],
        fracturedMods: ['+20 to maximum Life'],
        enchantMods: ['Line one\nLine two'],
    });
    assert.equal(d.rarity, 'rare');
    assert.deepEqual(
        d.explicits.map((m) => `${m.kind}:${m.text}`),
        ['fractured:+20 to maximum Life', 'explicit:+10 to Strength', 'crafted:+5 to Dexterity'],
    );
    assert.deepEqual(
        d.enchants.map((m) => m.text),
        ['Line one', 'Line two'],
    );
});

test('never throws, and drops what it cannot read', () => {
    const d: ItemView = readItemDisplay({
        icon: 'https://evil.example/x.png',
        properties: [null, 3, { name: 'Armour', values: 'nope' }],
        explicitMods: [5, { x: 1 }],
    });
    assert.equal(d.icon, null);
    assert.deepEqual(d.properties.map(text), ['Armour']);
    assert.deepEqual(d.explicits, []);
    assert.equal(readItemDisplay(null).rarity, 'other');
});

test('normal and magic items have no separate name', () => {
    assert.equal(readItemDisplay({ rarity: 'Magic', name: '', typeLine: "Athlete's Murder Boots of the Wind" }).name, '');
});

test('property display modes', () => {
    assert.equal(text(propertyLine({ name: 'Bow', values: [] }) ?? []), 'Bow');
    assert.equal(text(propertyLine({ name: 'Stack Size', values: [['3/10', 0]], displayMode: 1 }) ?? []), '3/10 Stack Size');
    assert.equal(
        text(
            propertyLine({
                name: 'Grants {0} of {1}',
                values: [
                    ['2', 1],
                    ['Foo', 0],
                ],
                displayMode: 3,
            }) ?? [],
        ),
        'Grants 2 of Foo',
    );
    assert.equal(
        text(
            propertyLine({
                name: 'Elemental Damage',
                values: [
                    ['1-10', 4],
                    ['2-20', 5],
                ],
                displayMode: 0,
            }) ?? [],
        ),
        'Elemental Damage: 1-10, 2-20',
    );
    assert.equal(propertyLine({ name: 'Experience', values: [['1', 0]], displayMode: 2 }), undefined);
});

test('strips link markup', () => {
    assert.equal(stripMarkup('[Poison|Poisons] and [Onslaught]'), 'Poisons and Onslaught');
});
