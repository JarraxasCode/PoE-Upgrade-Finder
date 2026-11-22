// Buy links (PLAN.md, Trade client, "Liveness and links"): a trade search that opens in the user's own
// browser and shows just that listing. Rare names can't be searched on the site, so the listing is pinned
// down by seller + base type + exact price + item level + the item's own mod lines (stat ids, presence
// only). On the gate run (22 Nov) seller + base showed 34 rings, and seller + base + price + item level still
// showed several: sellers price in batches. The mod lines make it unique in practice; no extra trade calls.
// Only https://www.pathofexile.com/trade/ URLs are opened.

export const TRADE_SITE: string = 'https://www.pathofexile.com/trade/';

/** Currencies the price filter's `option` takes by the same id as the listing's currency. */
const PRICE_OPTIONS: ReadonlySet<string> = new Set<string>(['chaos', 'divine']);

export interface LinkableItem {
    readonly seller: string | undefined;
    readonly baseType: string;
    readonly itemLevel?: number | undefined;
    /** The item's own mod lines; each one is required (presence only). */
    readonly statIds?: readonly string[] | undefined;
    readonly price?: { readonly amount: number; readonly currency: string } | undefined;
}

/** Undefined when the listing has no seller name. */
export function buyLink(league: string, item: LinkableItem): string | undefined {
    if (item.seller === undefined || item.seller === '') {
        return undefined;
    }
    const tradeFilters: Record<string, unknown> = { account: { input: item.seller } };
    if (item.price !== undefined && PRICE_OPTIONS.has(item.price.currency)) {
        tradeFilters['price'] = { min: item.price.amount, max: item.price.amount, option: item.price.currency };
    }
    const filters: Record<string, unknown> = { trade_filters: { filters: tradeFilters } };
    if (item.itemLevel !== undefined) {
        filters['misc_filters'] = { filters: { ilvl: { min: item.itemLevel, max: item.itemLevel } } };
    }
    const q: unknown = {
        query: {
            status: { option: 'any' },
            type: item.baseType,
            stats: [{ type: 'and', filters: (item.statIds ?? []).map((id: string) => ({ id: id })) }],
            filters: filters,
        },
    };
    return `${TRADE_SITE}search/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(q))}`;
}

/** The guard before anything is opened in the browser. */
export function isTradeSiteUrl(url: string): boolean {
    try {
        const u: URL = new URL(url);
        return u.protocol === 'https:' && u.host === 'www.pathofexile.com' && u.pathname.startsWith('/trade/');
    } catch {
        return false;
    }
}
