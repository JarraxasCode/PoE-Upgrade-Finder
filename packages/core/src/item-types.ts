// Which PoB item types a gear slot takes, and the trade site's category for each (PLAN.md, "v2a: the slot
// plan"). A plan's item type sets the search's category ("Bow": every bow base), its base sets `type` (one
// base); with neither, the category is PoB's, from the equipped item, as in v0.1.
//
// The categories are PoB's own (TradeHelpers.getTradeCategory in 2.68.1): a Rune Dagger is a Dagger and
// searches weapon.dagger, a Warstaff is a Staff and searches weapon.staff, exactly as v0.1 does for an
// equipped one. ipc's SLOT_ITEM_TYPES mirrors the slot lists for the renderer (a desktop test checks they match).

import type { GearSlot } from '@poe-upgrade-finder/engine-client';

const ONE_HANDED: readonly string[] = ['Claw', 'Dagger', 'One Handed Axe', 'One Handed Mace', 'One Handed Sword', 'Sceptre', 'Wand'];
const TWO_HANDED: readonly string[] = ['Bow', 'Staff', 'Two Handed Axe', 'Two Handed Mace', 'Two Handed Sword'];

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

export function slotTakes(slot: GearSlot, itemType: string): boolean {
    return SLOT_ITEM_TYPES[slot].includes(itemType);
}

/** The trade category for a PoB item type; undefined for a type the site has no category for here. */
export function categoryOf(itemType: string): string | undefined {
    return Object.hasOwn(ITEM_TYPE_CATEGORY, itemType) ? ITEM_TYPE_CATEGORY[itemType] : undefined;
}
