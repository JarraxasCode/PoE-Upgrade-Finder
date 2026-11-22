// The search request body, as the trade site takes it (the part of it the app sends). The query compiler in
// packages/core builds these; the trade client only sends them.

/** Instant buyout only (the default, D6), or include whisper listings from online sellers. */
export type ListingStatus = 'securable' | 'online';

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

export interface SearchFilters {
    readonly type_filters: { readonly filters: { readonly category: { readonly option: string }; readonly rarity: { readonly option: string } } };
    readonly req_filters?: { readonly filters: { readonly lvl?: { readonly max: number } } };
    readonly trade_filters: { readonly filters: { readonly price: PriceFilter } };
}

export interface SearchQuery {
    readonly status: { readonly option: ListingStatus };
    readonly stats: readonly StatGroup[];
    readonly filters: SearchFilters;
}

export interface TradeSearchBody {
    readonly query: SearchQuery;
    readonly sort: Readonly<Record<string, 'asc' | 'desc'>>;
}
