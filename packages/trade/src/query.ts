// The search request body, as the trade site takes it (the part of it the app sends). The query compiler in
// packages/core builds these; the trade client only sends them.

import type { ListingType } from '@poe-upgrade-finder/vocab';

export interface StatFilterValue {
    readonly min?: number;
    readonly max?: number;
    readonly weight?: number;
}

export interface StatFilter {
    readonly id: string;
    readonly value?: StatFilterValue;
}

export type StatGroupType = 'and' | 'not' | 'count' | 'weight' | 'weight2';

export interface StatGroup {
    readonly type: StatGroupType;
    readonly filters: readonly StatFilter[];
    readonly value?: { readonly min?: number; readonly max?: number };
}

export type PriceOption = 'chaos' | 'divine';

export interface PriceFilter {
    readonly min?: number;
    readonly max?: number;
    readonly option: PriceOption;
}

/** The site's rarity options the app sends: rares, or uniques for a unique search (#113). */
export type SearchRarityOption = 'rare' | 'unique';

/** One socket filter row as the site takes it; every field optional. */
export interface SocketFilter {
    readonly min?: number;
    readonly max?: number;
    readonly r?: number;
    readonly g?: number;
    readonly b?: number;
    readonly w?: number;
}

export interface SearchFilters {
    readonly type_filters: {
        readonly filters: { readonly category: { readonly option: string }; readonly rarity: { readonly option: SearchRarityOption } };
    };
    /** The item's defences (slot plan, issue #24): ar, ev, es, ward. */
    readonly armour_filters?: { readonly filters: Readonly<Record<string, { readonly min?: number; readonly max?: number }>> };
    /** The item's sockets and largest link group (slot plan, #58, V30): { min, max, r, g, b, w } per row. */
    readonly socket_filters?: {
        readonly filters: { readonly sockets?: SocketFilter; readonly links?: SocketFilter };
    };
    readonly req_filters?: { readonly filters: { readonly lvl?: { readonly max: number } } };
    readonly trade_filters: { readonly filters: { readonly price: PriceFilter } };
    /** Influence filters (slot plan, Phase 6), e.g. `{ shaper_item: { option: 'true' } }`. */
    readonly misc_filters?: { readonly filters: Readonly<Record<string, { readonly option: 'true' }>> };
}

export interface SearchQuery {
    readonly status: { readonly option: ListingType };
    /** One base, the site's name for it (V24: PoB's name without the bracketed variant). */
    readonly type?: string;
    /** One unique by name, e.g. "Kaom's Roots" (#113); with `type`, the site's unique filter. */
    readonly name?: string;
    readonly stats: readonly StatGroup[];
    readonly filters: SearchFilters;
}

export interface TradeSearchBody {
    readonly query: SearchQuery;
    readonly sort: Readonly<Record<string, 'asc' | 'desc'>>;
}
