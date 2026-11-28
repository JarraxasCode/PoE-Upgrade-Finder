// Which PoB item types a gear slot takes, and the trade site's category for each (PLAN.md, "v2a: the slot
// plan"). A plan's item type sets the search's category ("Bow": every bow base), its base sets `type` (one
// base); with neither, the category is PoB's, from the equipped item, as in v0.1.
//
// The categories are PoB's own (TradeHelpers.getTradeCategory in 2.68.1): a Rune Dagger is a Dagger and
// searches weapon.dagger, a Warstaff is a Staff and searches weapon.staff, exactly as v0.1 does for an
// equipped one.

import type { GearSlot } from './slots.ts';

export const ONE_HANDED: readonly string[] = ['Claw', 'Dagger', 'One Handed Axe', 'One Handed Mace', 'One Handed Sword', 'Sceptre', 'Wand'];
export const TWO_HANDED: readonly string[] = ['Bow', 'Staff', 'Two Handed Axe', 'Two Handed Mace', 'Two Handed Sword'];

/** PoB's item types (the slot data's keys) each slot can hold. */
export const SLOT_ITEM_TYPES: Readonly<Record<GearSlot, readonly string[]>> = {
    Helmet: ['Helmet'],
    'Body Armour': ['Body Armour'],
    Gloves: ['Gloves'],
    Boots: ['Boots'],
    Amulet: ['Amulet'],
    'Ring 1': ['Ring'],
    'Ring 2': ['Ring'],
    Belt: ['Belt'],
    'Weapon 1': [...ONE_HANDED, ...TWO_HANDED].sort(),
    // A two-hander leaves the off hand empty; a bow takes a quiver there.
    'Weapon 2': [...ONE_HANDED, 'Quiver', 'Shield'].sort(),
};

/** The trade category per PoB item type (PoB's TradeHelpers.getTradeCategory). */
export const ITEM_TYPE_CATEGORY: Readonly<Record<string, string>> = {
    Helmet: 'armour.helmet',
    'Body Armour': 'armour.chest',
    Gloves: 'armour.gloves',
    Boots: 'armour.boots',
    Shield: 'armour.shield',
    Quiver: 'armour.quiver',
    Amulet: 'accessory.amulet',
    Ring: 'accessory.ring',
    Belt: 'accessory.belt',
    Bow: 'weapon.bow',
    Claw: 'weapon.claw',
    Dagger: 'weapon.dagger',
    'One Handed Axe': 'weapon.oneaxe',
    'One Handed Mace': 'weapon.onemace',
    'One Handed Sword': 'weapon.onesword',
    Sceptre: 'weapon.sceptre',
    Staff: 'weapon.staff',
    'Two Handed Axe': 'weapon.twoaxe',
    'Two Handed Mace': 'weapon.twomace',
    'Two Handed Sword': 'weapon.twosword',
    Wand: 'weapon.wand',
};

/** The item types with armour, evasion, energy shield or ward (the slot plan's defences, issue #24). */
export const DEFENCE_ITEM_TYPES: readonly string[] = ['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Shield'];

export function hasDefences(itemType: string | null): boolean {
    return itemType !== null && DEFENCE_ITEM_TYPES.includes(itemType);
}

// Generic weapon types (#39, decided by Jarraxas on 26 Nov): Weapon 1 can search a whole group of the site's
// weapon categories (V28) rather than one PoB item type. PoB's mod data is per item type, so such a plan holds the
// category and totals only: no base, mods or defences. A result is scored as any Weapon 1 item is: beside the
// off-hand when it fits there, else with Weapon 2 emptied (the weapon-hand rules below).

export interface GenericWeaponType {
    readonly name: string;
    /** The site's category (V28). */
    readonly category: string;
    /** The PoB item types its results can be, for the weapon-hand rules; the site's category decides what comes back. */
    readonly members: readonly string[];
    /** How a plan summary names it: "Any weapon", "Any one-handed weapon". */
    readonly any: string;
}

/** The generic types, in the order the editor offers them. */
export const GENERIC_WEAPON_TYPES: readonly GenericWeaponType[] = [
    { name: 'Any weapon', category: 'weapon', members: [...ONE_HANDED, ...TWO_HANDED].sort(), any: 'Any weapon' },
    { name: 'One-handed weapon', category: 'weapon.one', members: ONE_HANDED, any: 'Any one-handed weapon' },
    {
        name: 'Two-handed melee',
        category: 'weapon.twomelee',
        members: ['Staff', 'Two Handed Axe', 'Two Handed Mace', 'Two Handed Sword'],
        any: 'Any two-handed melee weapon',
    },
];

function genericOf(itemType: string | null): GenericWeaponType | undefined {
    return GENERIC_WEAPON_TYPES.find((g: GenericWeaponType) => g.name === itemType);
}

/** Whether an item type is one of the generic weapon types (no slot data: category and totals only). */
export function isGenericType(itemType: string | null): boolean {
    return genericOf(itemType) !== undefined;
}

/** The PoB item types a plan's type takes in: a generic type's members, else the type itself. */
export function memberTypes(itemType: string): readonly string[] {
    return genericOf(itemType)?.members ?? [itemType];
}

/** "Any weapon" for a generic type, "Any wand base" for a PoB one. */
export function anyOfType(itemType: string): string {
    return genericOf(itemType)?.any ?? `Any ${itemType.toLowerCase()} base`;
}

/** Whether a slot's plan can pick this type: a PoB type the slot holds, or (Weapon 1) a generic weapon type. */
export function slotTakes(slot: GearSlot, itemType: string): boolean {
    return SLOT_ITEM_TYPES[slot].includes(itemType) || (slot === 'Weapon 1' && isGenericType(itemType));
}

/** The trade category for a PoB item type or a generic weapon type; undefined for a type the site has no category for here. */
export function categoryOf(itemType: string): string | undefined {
    const generic: GenericWeaponType | undefined = genericOf(itemType);
    if (generic !== undefined) {
        return generic.category;
    }
    return Object.hasOwn(ITEM_TYPE_CATEGORY, itemType) ? ITEM_TYPE_CATEGORY[itemType] : undefined;
}

// Weapon hands (issue #39; the game's rule, poe1-mechanics G6, as PoB's ItemsTab:IsItemValidForSlot has it in
// 2.68.1). PoB's Fishing Rod is two-handed too; the app doesn't search it, but it can be equipped.

/** Whether a PoB weapon type takes both hands. */
export function isTwoHanded(itemType: string): boolean {
    return TWO_HANDED.includes(itemType) || itemType === 'Fishing Rod';
}

/**
 * What Weapon 2 can hold beside a Weapon 1 of this PoB item type (null: Weapon 1 is empty). A bow: a quiver only;
 * another two-hander: nothing; a wand: a shield or a wand; another one-hander: a shield or a one-hander that
 * isn't a wand; nothing: a shield or any one-hander.
 */
export function offHandTypes(weapon1Type: string | null): readonly string[] {
    if (weapon1Type === null) {
        return [...ONE_HANDED, 'Shield'].sort();
    }
    if (weapon1Type === 'Bow') {
        return ['Quiver'];
    }
    if (!ONE_HANDED.includes(weapon1Type)) {
        return [];
    }
    if (weapon1Type === 'Wand') {
        return ['Shield', 'Wand'];
    }
    return [...ONE_HANDED.filter((t: string) => t !== 'Wand'), 'Shield'].sort();
}

/** Whether a Weapon 2 item of this type can be held beside a Weapon 1 of that type (null: Weapon 1 empty). */
export function fitsBeside(weapon1Type: string | null, weapon2Type: string): boolean {
    return offHandTypes(weapon1Type).includes(weapon2Type);
}

/**
 * The item types a slot's plan can pick, given what Weapon 1 holds (only Weapon 2 depends on it). Weapon 1 offers
 * the generic weapon types first.
 */
export function slotItemTypes(slot: GearSlot, weapon1Type: string | null): readonly string[] {
    if (slot === 'Weapon 2') {
        return offHandTypes(weapon1Type);
    }
    if (slot === 'Weapon 1') {
        return [...GENERIC_WEAPON_TYPES.map((g: GenericWeaponType) => g.name), ...SLOT_ITEM_TYPES[slot]];
    }
    return SLOT_ITEM_TYPES[slot];
}
