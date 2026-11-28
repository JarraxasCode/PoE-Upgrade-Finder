// An item as the tooltip draws it (PLAN.md, Phase 4, "Item images and tooltips"): read by trade from a fetched
// listing, assigned straight into the IPC contract, and drawn by the renderer. An equipped item from the PoB
// save has the same groups (engine-client's PobItemView), without the image.

const ITEM_TONE_LIST = ['plain', 'augmented', 'unmet', 'fire', 'cold', 'lightning', 'chaos', 'label'] as const;
/** How a value is coloured in game: the trade API's value type (0 plain, 1 augmented, 2 unmet, 4-7 elements). */
export type ItemTone = (typeof ITEM_TONE_LIST)[number];
export const ITEM_TONES: readonly ItemTone[] = ITEM_TONE_LIST;

const ITEM_MOD_KIND_LIST = ['enchant', 'implicit', 'explicit', 'crafted', 'fractured', 'scourge', 'crucible'] as const;
export type ItemModKind = (typeof ITEM_MOD_KIND_LIST)[number];
export const ITEM_MOD_KINDS: readonly ItemModKind[] = ITEM_MOD_KIND_LIST;

const ITEM_RARITY_LIST = ['normal', 'magic', 'rare', 'unique', 'other'] as const;
export type ItemRarity = (typeof ITEM_RARITY_LIST)[number];
export const ITEM_RARITIES: readonly ItemRarity[] = ITEM_RARITY_LIST;

const ITEM_INFLUENCE_LIST = ['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord', 'searing', 'tangled'] as const;
/** The influences as the trade site and PoB's item text name them (the slot plan's SlotInfluence uses PoB's mod pool names). */
export type ItemInfluence = (typeof ITEM_INFLUENCE_LIST)[number];
export const ITEM_INFLUENCES: readonly ItemInfluence[] = ITEM_INFLUENCE_LIST;

export interface ItemPart {
    readonly text: string;
    readonly tone: ItemTone;
}

/** One line of the tooltip, in parts so each value can be coloured. */
export type ItemLine = readonly ItemPart[];

export interface ItemMod {
    readonly text: string;
    readonly kind: ItemModKind;
}

export interface ItemView {
    /** An image on web.poecdn.com, or null (nothing else passes the renderer's CSP). */
    readonly icon: string | null;
    /** Inventory cells, for the image's shape. */
    readonly width: number;
    readonly height: number;
    readonly rarity: ItemRarity;
    /** Empty for normal and magic items, whose whole name is the type line. */
    readonly name: string;
    readonly typeLine: string;
    readonly influences: readonly ItemInfluence[];
    readonly properties: readonly ItemLine[];
    /** "Requires Level 64, Dex 62", or empty. */
    readonly requirements: ItemLine;
    /** "R-G-B B", or empty. */
    readonly sockets: string;
    readonly itemLevel: number | null;
    /** Enchants, then implicits, then the rest (explicit, crafted, fractured...) in the site's order. */
    readonly enchants: readonly ItemMod[];
    readonly implicits: readonly ItemMod[];
    readonly explicits: readonly ItemMod[];
    readonly corrupted: boolean;
    readonly mirrored: boolean;
}

/** Only images from GGG's CDN are kept; the renderer's CSP allows nothing else. */
export const ICON_ORIGIN: string = 'https://web.poecdn.com/';
