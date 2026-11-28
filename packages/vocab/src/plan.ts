// The slot plan (PLAN.md, "v2a: the slot plan" and "Phase 6"): what to search for on one slot, as plain data
// that knows nothing about the run around it. The base, implicits, up to 3 prefixes and 3 suffixes, each mod
// Include (results must have it) or Exclude (results never have it). core checks a plan and builds the spec
// from it; ipc checks every plan that comes in; the renderer edits it.

import type { GearSlot } from './slots.ts';

const SLOT_INFLUENCE_LIST = ['none', 'shaper', 'elder', 'adjudicator', 'basilisk', 'crusader', 'eyrie'] as const;
/** PoB's influence names (adjudicator = Warlord, basilisk = Hunter, eyrie = Redeemer); `none` is the plain pool. */
export type SlotInfluence = (typeof SLOT_INFLUENCE_LIST)[number];
export const SLOT_INFLUENCES: readonly SlotInfluence[] = SLOT_INFLUENCE_LIST;

/** An item has at most two influences (two conquerors, or Shaper/Elder with a conqueror, via the Awakener's Orb). */
export const MAX_INFLUENCES: number = 2;

const SLOT_MOD_TYPE_LIST = ['Prefix', 'Suffix', 'Exarch', 'Eater', 'Corrupted'] as const;
/** PoB's mod types in the slot data: affixes, eldritch implicits (Exarch, Eater) and corrupted implicits. */
export type SlotModType = (typeof SLOT_MOD_TYPE_LIST)[number];
export const SLOT_MOD_TYPES: readonly SlotModType[] = SLOT_MOD_TYPE_LIST;

const SLOT_SOURCE_LIST = ['natural', 'fossil', 'crafted', 'essence', 'veiled', 'beast', 'necropolis', 'delve', 'incursion'] as const;
/**
 * Where a mod comes from (issue #32), as PoB's "Add modifier" screen has them: natural rolls, fossil (a natural
 * Delve-only affix), the crafting bench, essence-only mods, veiled (Betrayal), beastcrafts, Necropolis corpses,
 * and Delve or Incursion drop-restricted mods.
 */
export type SlotSource = (typeof SLOT_SOURCE_LIST)[number];
export const SLOT_SOURCES: readonly SlotSource[] = SLOT_SOURCE_LIST;

const MOD_RULE_LIST = ['include', 'exclude'] as const;
export type ModRule = (typeof MOD_RULE_LIST)[number];
export const MOD_RULES: readonly ModRule[] = MOD_RULE_LIST;

const MOD_POSITION_LIST = ['implicit', 'prefix', 'suffix'] as const;
export type ModPosition = (typeof MOD_POSITION_LIST)[number];
export const MOD_POSITIONS: readonly ModPosition[] = MOD_POSITION_LIST;

const DEFENCE_KIND_LIST = ['armour', 'evasion', 'energyShield', 'ward'] as const;
/** The defences a base can have, as the slot plan names them, in the order the editor and the query use. */
export type DefenceKind = (typeof DEFENCE_KIND_LIST)[number];
export const DEFENCE_KINDS: readonly DefenceKind[] = DEFENCE_KIND_LIST;

export const DEFENCE_NAMES: Readonly<Record<DefenceKind, string>> = {
    armour: 'Armour',
    evasion: 'Evasion',
    energyShield: 'Energy Shield',
    ward: 'Ward',
};

/** One trade stat of a picked mod. A hybrid mod has two. */
export interface PickStat {
    /** Trade stat id, e.g. explicit.stat_2250533757 (implicit.stat_… for implicits). */
    readonly statId: string;
    /**
     * Include only: the range on the item's total for the stat, as the mod reads ("reduced 20 to 32" is
     * 20 and 32). A stat the site words the opposite way is negated and swapped when sent. Either end optional.
     */
    readonly min?: number;
    readonly max?: number;
}

/**
 * A pseudo total the item must reach (issue #26), from any source: "+# total maximum Life ≥ 80" is met by life,
 * Strength or both. Its own pick, as on the site; a mod include always means the mod itself.
 */
export interface PlanTotal {
    /** The site's pseudo stat id, e.g. pseudo.pseudo_total_life. */
    readonly statId: string;
    /** The site's wording, e.g. "+# total maximum Life" (kept with the plan so the spec needs no stat list). */
    readonly text: string;
    readonly min?: number;
    readonly max?: number;
}

/** At most this many totals in one plan (each costs 1 on the site's complexity). */
export const MAX_TOTALS: number = 10;

export interface ModPick {
    readonly position: ModPosition;
    /** PoB's mod group (the "one per group" rule); null for the base's own implicit. */
    readonly group: string | null;
    /** The pool the mod comes from: `none` for plain mods (and implicits), else the influence that adds it. */
    readonly influence: SlotInfluence;
    readonly rule: ModRule;
    readonly stats: readonly PickStat[];
}

/** A whole-number range on one defence, as listed; either end optional. */
export interface DefenceRange {
    readonly min?: number;
    readonly max?: number;
}

export type PlanDefences = Readonly<Partial<Record<DefenceKind, DefenceRange>>>;

const SOCKET_COLOUR_LIST = ['r', 'g', 'b', 'w'] as const;
/** The site's socket colours (red, green, blue, white). */
export type SocketColour = (typeof SOCKET_COLOUR_LIST)[number];
export const SOCKET_COLOURS: readonly SocketColour[] = SOCKET_COLOUR_LIST;

const SOCKET_END_LIST = ['r', 'g', 'b', 'w', 'min', 'max'] as const;
/** The fields of one socket filter row, as on the trade site: a count per colour, and min and max. */
export type SocketEnd = (typeof SOCKET_END_LIST)[number];
export const SOCKET_ENDS: readonly SocketEnd[] = SOCKET_END_LIST;

const SOCKET_ROW_LIST = ['sockets', 'links'] as const;
/** The site's two socket filter rows: all sockets, and the largest linked group (V30). */
export type SocketRow = (typeof SOCKET_ROW_LIST)[number];
export const SOCKET_ROWS: readonly SocketRow[] = SOCKET_ROW_LIST;

/** One socket filter row; every field optional, each a whole number from 0 to MAX_SOCKET_VALUE. */
export type SocketRange = Readonly<Partial<Record<SocketEnd, number>>>;

/** The trade site's socket filters (#58), by row; a row with no field set is left out. */
export type PlanSockets = Readonly<Partial<Record<SocketRow, SocketRange>>>;

/** The largest number a socket filter field takes (six sockets at most on any item). */
export const MAX_SOCKET_VALUE: number = 6;

/** A unique picked for the slot (#113): the run searches that unique alone, weighted by its own rolls. */
export interface PickedUnique {
    /** PoB's name, e.g. "Kaom's Roots". */
    readonly name: string;
    /** PoB's base name, e.g. "Titan Greaves". */
    readonly base: string;
    /** The site's name for the base (the search's `type`), from the engine. */
    readonly tradeType: string;
}

export interface SlotPlan {
    readonly slot: GearSlot;
    /**
     * PoB's item type ("Boots", "Bow"): picks the slot data and sets the search's category (every base of the
     * type). Null: PoB's category, from the equipped item, as in v0.1. Weapon slots offer several (SLOT_ITEM_TYPES).
     * Weapon 1 can also take a generic weapon type ("Any weapon", GENERIC_WEAPON_TYPES, #39): a category with
     * totals only, since it has no slot data.
     */
    readonly itemType: string | null;
    /** PoB's base name ("Two-Toned Boots (Armour/Evasion)"); null: any base of the type. */
    readonly base: string | null;
    readonly picks: readonly ModPick[];
    /**
     * Ranges on the item's Armour, Evasion, Energy Shield and Ward as listed (issue #24), on item types that have
     * them. "Max Energy Shield 0, max Evasion 0" is a pure armour base. Missing or empty: no defence filter.
     */
    readonly defences?: PlanDefences;
    /** Pseudo totals the item must reach (issue #26). Missing or empty: none. */
    readonly totals?: readonly PlanTotal[];
    /**
     * The trade site's socket filters (#58), on any item type (the user knows what can have sockets). They need
     * no item type. Missing or empty: none.
     */
    readonly sockets?: PlanSockets;
    /**
     * A unique search (#113): this unique only. Such a plan has an item type and nothing else: no base, mods,
     * defences or totals (the rare plan is kept beside it in the settings, not in it). Socket filters are allowed.
     */
    readonly unique?: PickedUnique;
}

const UNIQUE_MODE_LIST = ['rare', 'unique'] as const;
/** What a slot's search looks for (#113): rares by the slot plan, or one picked unique. */
export type UniqueMode = (typeof UNIQUE_MODE_LIST)[number];
export const UNIQUE_MODES: readonly UniqueMode[] = UNIQUE_MODE_LIST;

/** A slot's Rare / Unique switch and its picked unique, kept beside the rare plan (switching back keeps the plan). */
export interface UniqueChoice {
    readonly mode: UniqueMode;
    /** The last unique picked for the slot; null: none yet. */
    readonly unique: PickedUnique | null;
}

/** Whether the plan searches one picked unique. */
export function isUniquePlan(plan: SlotPlan): plan is SlotPlan & { readonly unique: PickedUnique } {
    return plan.unique !== undefined;
}

/** Whether the plan sets any socket filter field (#58). */
export function hasSockets(plan: SlotPlan): boolean {
    return SOCKET_ROWS.some((row: SocketRow) => Object.keys(plan.sockets?.[row] ?? {}).length > 0);
}

const SOCKET_ROW_NAMES: Readonly<Record<SocketRow, string>> = { sockets: 'Sockets', links: 'Links' };

/** One socket filter row in short: "Sockets 6", "Links ≥ 5, 3 R", "Links 3 R 1 W", "Sockets 4 to 5". */
export function socketRowText(row: SocketRow, range: SocketRange): string {
    const { min, max } = range;
    const span: string =
        min !== undefined && max !== undefined
            ? min === max
                ? `${min}`
                : `${min} to ${max}`
            : min !== undefined
              ? `≥ ${min}`
              : max !== undefined
                ? `≤ ${max}`
                : '';
    const colours: string = SOCKET_COLOURS.filter((c: SocketColour) => range[c] !== undefined)
        .map((c: SocketColour) => `${range[c] ?? 0} ${c.toUpperCase()}`)
        .join(' ');
    const name: string = SOCKET_ROW_NAMES[row];
    if (span === '') {
        return `${name} ${colours}`;
    }
    return colours === '' ? `${name} ${span}` : `${name} ${span}, ${colours}`;
}

/** How many prefixes and suffixes an item of one base can have (3 and 3, unless its implicits say otherwise). */
export interface AffixLimits {
    readonly prefix: number;
    readonly suffix: number;
}

/** What one base allows on its affixes (issue #37): its limits, and the % its implicits raise each side's values by. */
export interface BaseAffixes {
    readonly limits: AffixLimits;
    /** "50% increased Suffix Modifier magnitudes" is suffix 50; "100% increased Explicit Modifier magnitudes" is both. */
    readonly magnitudes: AffixLimits;
}

/** A base that doesn't change its affixes: 3 prefixes, 3 suffixes, no magnitude bonus. */
export const PLAIN_AFFIXES: BaseAffixes = { limits: { prefix: 3, suffix: 3 }, magnitudes: { prefix: 0, suffix: 0 } };

export function emptySlotPlan(slot: GearSlot): SlotPlan {
    return { slot: slot, itemType: null, base: null, picks: [] };
}
