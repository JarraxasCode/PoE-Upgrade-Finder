import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    anyOfType,
    ATTRIBUTES,
    categoryOf,
    DEFENCE_KINDS,
    DEFENCE_NAMES,
    ELEMENTS,
    fitsBeside,
    GEAR_SLOTS,
    GENERIC_WEAPON_TYPES,
    isGearSlot,
    isGenericType,
    isTwoHanded,
    ITEM_INFLUENCES,
    ITEM_MOD_KINDS,
    ITEM_RARITIES,
    ITEM_TONES,
    ITEM_TYPE_CATEGORY,
    JUNK_REASONS,
    LEVEL_FILTER_KINDS,
    LISTING_TYPES,
    MOD_POSITIONS,
    memberTypes,
    MOD_RULES,
    offHandTypes,
    ONE_HANDED,
    PRUNE_REASONS,
    SEARCH_DEPTHS,
    SLOT_INFLUENCES,
    SLOT_ITEM_TYPES,
    slotItemTypes,
    slotTakes,
    SLOT_MOD_TYPES,
    SLOT_SOURCES,
} from '@poe-upgrade-finder/vocab';

// Each list is the source of its union, so it can't miss a member; it could still repeat one.
test('no list repeats a member', () => {
    const lists: Readonly<Record<string, readonly string[]>> = {
        ATTRIBUTES,
        DEFENCE_KINDS,
        ELEMENTS,
        GEAR_SLOTS,
        ITEM_INFLUENCES,
        ITEM_MOD_KINDS,
        ITEM_RARITIES,
        ITEM_TONES,
        JUNK_REASONS,
        LEVEL_FILTER_KINDS,
        LISTING_TYPES,
        MOD_POSITIONS,
        MOD_RULES,
        PRUNE_REASONS,
        SEARCH_DEPTHS,
        SLOT_INFLUENCES,
        SLOT_MOD_TYPES,
        SLOT_SOURCES,
        ...Object.fromEntries(Object.entries(SLOT_ITEM_TYPES).map(([slot, types]) => [`SLOT_ITEM_TYPES[${slot}]`, types])),
    };
    for (const [name, list] of Object.entries(lists)) {
        assert.equal(new Set(list).size, list.length, name);
    }
});

test('every item type a slot takes has a trade category', () => {
    for (const slot of GEAR_SLOTS) {
        for (const itemType of SLOT_ITEM_TYPES[slot]) {
            assert.equal(categoryOf(itemType), ITEM_TYPE_CATEGORY[itemType], `${slot}: ${itemType}`);
            assert.notEqual(categoryOf(itemType), undefined, `${slot}: ${itemType}`);
        }
    }
    assert.equal(categoryOf('toString'), undefined);
});

test('every defence has a name, and slots are recognised by name', () => {
    assert.deepEqual(Object.keys(DEFENCE_NAMES), [...DEFENCE_KINDS]);
    assert.equal(isGearSlot('Ring 2'), true);
    assert.equal(isGearSlot('Ring'), false);
});

test('Weapon 2 holds what fits beside Weapon 1 (#39, G6)', () => {
    const oneHanders: readonly string[] = ['Claw', 'Dagger', 'One Handed Axe', 'One Handed Mace', 'One Handed Sword', 'Sceptre', 'Wand'];
    assert.deepEqual(offHandTypes(null), [...oneHanders, 'Shield'].sort());
    assert.deepEqual(offHandTypes('Bow'), ['Quiver']);
    assert.deepEqual(offHandTypes('Wand'), ['Shield', 'Wand']);
    assert.deepEqual(offHandTypes('Sceptre'), [
        'Claw',
        'Dagger',
        'One Handed Axe',
        'One Handed Mace',
        'One Handed Sword',
        'Sceptre',
        'Shield',
    ]);
    for (const twoHander of ['Staff', 'Two Handed Axe', 'Two Handed Mace', 'Two Handed Sword', 'Fishing Rod']) {
        assert.deepEqual(offHandTypes(twoHander), [], twoHander);
        assert.equal(isTwoHanded(twoHander), true, twoHander);
    }
    assert.equal(isTwoHanded('Bow'), true);
    assert.equal(isTwoHanded('Wand'), false);
    assert.equal(fitsBeside('Wand', 'One Handed Sword'), false);
    assert.equal(fitsBeside('One Handed Sword', 'Wand'), false);
    assert.equal(fitsBeside('Dagger', 'Shield'), true);
    assert.equal(fitsBeside(null, 'Quiver'), false);
    assert.deepEqual(slotItemTypes('Weapon 2', 'Bow'), ['Quiver']);
    assert.deepEqual(slotItemTypes('Weapon 1', 'Bow'), [
        'Any weapon',
        'One-handed weapon',
        'Two-handed melee',
        ...SLOT_ITEM_TYPES['Weapon 1'],
    ]);
    // Every Weapon 1 type offered is one the slot takes, with a category.
    for (const t of slotItemTypes('Weapon 1', null)) {
        assert.ok(slotTakes('Weapon 1', t), t);
        assert.notEqual(categoryOf(t), undefined, t);
    }
    // Every type offered is one the slot takes.
    for (const w1 of [null, ...SLOT_ITEM_TYPES['Weapon 1']]) {
        for (const t of offHandTypes(w1)) {
            assert.ok(SLOT_ITEM_TYPES['Weapon 2'].includes(t), `${String(w1)}: ${t}`);
        }
    }
});

test('generic weapon types (#39): Weapon 1 only, the site category, PoB types as members', () => {
    assert.deepEqual(
        GENERIC_WEAPON_TYPES.map((g) => [g.name, g.category]),
        [
            ['Any weapon', 'weapon'],
            ['One-handed weapon', 'weapon.one'],
            ['Two-handed melee', 'weapon.twomelee'],
        ],
    );
    assert.equal(isGenericType('Any weapon'), true);
    assert.equal(isGenericType('Bow'), false);
    assert.equal(isGenericType(null), false);
    assert.equal(slotTakes('Weapon 1', 'One-handed weapon'), true);
    assert.equal(slotTakes('Weapon 2', 'One-handed weapon'), false);
    assert.deepEqual(memberTypes('One-handed weapon'), ONE_HANDED);
    assert.deepEqual(memberTypes('Wand'), ['Wand']);
    // Every member is a PoB Weapon 1 type; a two-handed melee type is two-handed.
    for (const g of GENERIC_WEAPON_TYPES) {
        for (const m of g.members) {
            assert.ok(SLOT_ITEM_TYPES['Weapon 1'].includes(m), `${g.name}: ${m}`);
        }
    }
    assert.ok(memberTypes('Two-handed melee').every((t) => isTwoHanded(t) && t !== 'Bow'));
    assert.equal(anyOfType('Two-handed melee'), 'Any two-handed melee weapon');
    assert.equal(anyOfType('Wand'), 'Any wand base');
    // Generic types stay out of the PoB table (the golden tests ask PoB for each of its types).
    assert.ok(SLOT_ITEM_TYPES['Weapon 1'].every((t) => !isGenericType(t)));
});
