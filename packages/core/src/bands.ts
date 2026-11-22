// Price bands (PLAN.md, Trade client, "Bands from the budget", and Scoring & ranking, "Prices").
//
// From a budget B (chaos): ≤ 1c · 1c to B/9 · B/9 to B/3 · B/3 to B, plus "slightly over budget" (B to 1.25 B),
// which is shown but never picked. With a min price M (fewer searches when cheap items don't
// matter), nothing under M is searched: the first band is M to the next edge above M. Edges are whole chaos
// from 10c up (labels without decimals), two decimals below that. Each band is two searches (V19): option chaos with the chaos edges, and
// option divine with the edges divided by the divine rate. The divine search is skipped when the band's top
// edge is under 1 divine. Adjacent bands share their edge; the run skips ids it has already fetched.

import type { PriceFilter, PriceOption } from '@poe-upgrade-finder/trade';

export type BandRole = 'main' | 'over';

export interface PriceBand {
    readonly id: string;
    /** "1c to 33c". */
    readonly label: string;
    /** Undefined: no lower edge. */
    readonly minChaos: number | undefined;
    readonly maxChaos: number;
    readonly role: BandRole;
}

export interface BandSettings {
    /** Top of the cheapest band, chaos. Default 1. */
    readonly floorChaos?: number;
    /** Fractions of the budget between the cheapest band and the budget. Default [1/9, 1/3]. */
    readonly fractions?: readonly number[];
    /** Top of the over-budget band as a multiple of the budget; 0 for none. Default 1.25. */
    readonly overFactor?: number;
    /** The user's min price, chaos: nothing cheaper is searched. Undefined: from the floor up. */
    readonly minChaos?: number;
}

export type SearchDepth = 'thorough' | 'normal' | 'quick';

/** Listings scored per band (PLAN: Thorough 100, Normal 50, Quick 20). */
export const DEPTH_PER_BAND: Readonly<Record<SearchDepth, number>> = { thorough: 100, normal: 50, quick: 20 };

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Whole chaos from 10c up, two decimals under (1.67c matters, 236.61c doesn't). */
export function roundEdge(n: number): number {
    return n >= 10 ? Math.round(n) : round2(n);
}

function chaosLabel(n: number): string {
    return `${roundEdge(n)}c`;
}

export function priceBands(budgetChaos: number, settings: BandSettings = {}): PriceBand[] {
    if (!(budgetChaos > 0) || !Number.isFinite(budgetChaos)) {
        throw new RangeError(`the budget must be a positive number of chaos, got ${budgetChaos}`);
    }
    const floor: number = settings.floorChaos ?? 1;
    const fractions: readonly number[] = settings.fractions ?? [1 / 9, 1 / 3];
    const overFactor: number = settings.overFactor ?? 1.25;
    const budget: number = roundEdge(budgetChaos);
    const min: number | undefined = settings.minChaos === undefined || !(settings.minChaos > 0) ? undefined : roundEdge(settings.minChaos);
    if (min !== undefined && min >= budget) {
        throw new RangeError(`the min price (${min}c) must be under the budget (${budget}c)`);
    }
    // Strictly increasing edges from the floor (or above the min) up to (not including) the budget, then the budget.
    const edges: number[] = [];
    for (const e of [floor, ...fractions.map((f: number) => f * budgetChaos)]) {
        const edge: number = roundEdge(e);
        if (edge >= floor && edge > (edges[edges.length - 1] ?? 0) && edge < budget && (min === undefined || edge > min)) {
            edges.push(edge);
        }
    }
    edges.push(budget);
    const bands: PriceBand[] = [];
    let previous: number | undefined = min;
    for (const edge of edges) {
        bands.push({
            id: `band-${bands.length + 1}`,
            label: previous === undefined ? `up to ${chaosLabel(edge)}` : `${chaosLabel(previous)} to ${chaosLabel(edge)}`,
            minChaos: previous,
            maxChaos: edge,
            role: 'main',
        });
        previous = edge;
    }
    if (overFactor > 1) {
        const top: number = roundEdge(budgetChaos * overFactor);
        bands.push({ id: 'over', label: `${chaosLabel(budget)} to ${chaosLabel(top)} (slightly over budget)`, minChaos: budget, maxChaos: top, role: 'over' });
    }
    return bands;
}

export interface BandSearch {
    readonly bandId: string;
    readonly option: PriceOption;
    readonly price: PriceFilter;
}

/**
 * The searches for one band. Divine edges are rounded outwards to 2 decimals. Without a divine rate only the
 * chaos search runs (the caller warns that divine-priced listings are missed).
 */
export function bandSearches(band: PriceBand, chaosPerDivine: number | undefined): BandSearch[] {
    const chaos: PriceFilter = band.minChaos === undefined ? { max: band.maxChaos, option: 'chaos' } : { min: band.minChaos, max: band.maxChaos, option: 'chaos' };
    const searches: BandSearch[] = [{ bandId: band.id, option: 'chaos', price: chaos }];
    if (chaosPerDivine !== undefined && chaosPerDivine > 0 && band.maxChaos >= chaosPerDivine) {
        const max: number = Math.ceil((band.maxChaos / chaosPerDivine) * 100) / 100;
        const divine: PriceFilter =
            band.minChaos === undefined ? { max: max, option: 'divine' } : { min: Math.floor((band.minChaos / chaosPerDivine) * 100) / 100, max: max, option: 'divine' };
        searches.push({ bandId: band.id, option: 'divine', price: divine });
    }
    return searches;
}

export interface SearchSize {
    /** The site's total for the search (capped at 10,000). */
    readonly total: number;
    /** Ids it returned (at most 100). */
    readonly available: number;
}

/**
 * How many of each search's ids to fetch for one band: the depth split in proportion to the totals, at least
 * 10 each when both have results (and the depth allows), never more than a search returned; what one search
 * can't use goes to the others.
 */
export function splitDepth(depth: number, searches: readonly SearchSize[]): number[] {
    const counts: number[] = searches.map(() => 0);
    const withResults: number[] = searches.map((s: SearchSize, i: number) => (s.available > 0 ? i : -1)).filter((i: number) => i >= 0);
    if (withResults.length === 0 || depth <= 0) {
        return counts;
    }
    const minEach: number = depth >= 10 * withResults.length ? 10 : 0;
    const totalSum: number = withResults.reduce((sum: number, i: number) => sum + (searches[i]?.total ?? 0), 0);
    for (const i of withResults) {
        const s: SearchSize | undefined = searches[i];
        if (s === undefined) {
            continue;
        }
        const share: number = totalSum > 0 ? Math.floor((depth * s.total) / totalSum) : Math.floor(depth / withResults.length);
        counts[i] = Math.min(s.available, Math.max(minEach, share));
    }
    // Hand out what's left (rounding, or a search with fewer ids than its share) to searches with ids to spare.
    let left: number = depth - counts.reduce((a: number, b: number) => a + b, 0);
    while (left > 0) {
        let gave: boolean = false;
        for (const i of withResults) {
            const s: SearchSize | undefined = searches[i];
            const c: number = counts[i] ?? 0;
            if (left > 0 && s !== undefined && c < s.available) {
                counts[i] = c + 1;
                left--;
                gave = true;
            }
        }
        if (!gave) {
            break;
        }
    }
    // Over the depth (the 10-each minimum can push it over): take back from the largest.
    let over: number = counts.reduce((a: number, b: number) => a + b, 0) - depth;
    while (over > 0) {
        let largest: number = -1;
        for (const i of withResults) {
            if (largest < 0 || (counts[i] ?? 0) > (counts[largest] ?? 0)) {
                largest = i;
            }
        }
        counts[largest] = (counts[largest] ?? 0) - 1;
        over--;
    }
    return counts;
}

/** A listing's price in chaos at the run's rate; undefined for other currencies (flagged, not converted). */
export function chaosEquivalent(price: { readonly amount: number; readonly currency: string } | undefined, chaosPerDivine: number | undefined): number | undefined {
    if (price === undefined) {
        return undefined;
    }
    if (price.currency === 'chaos') {
        return price.amount;
    }
    if (price.currency === 'divine' && chaosPerDivine !== undefined) {
        return price.amount * chaosPerDivine;
    }
    return undefined;
}
