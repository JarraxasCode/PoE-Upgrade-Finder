// Price bands (PLAN.md, Trade client, "Bands from the budget", and Scoring & ranking, "Prices").
//
// From a budget B (chaos): ≤ 1c · 1c to B/9 · B/9 to B/3 · B/3 to B, plus "slightly over budget" (B to 1.25 B),
// which is shown but never picked. With a min price M (fewer searches when cheap items don't
// matter), nothing under M is searched: the first band is M to the next edge above M. Edges are whole chaos
// from 10c up (labels without decimals), two decimals below that. Each band is two searches (V19): option chaos with the chaos edges, and
// option divine with the edges divided by the divine rate. The divine search is skipped when the band's top
// edge is under 1 divine.
//
// Listings are priced in whole chaos and whole divines (#57: none of about 4,600 recorded listings had a
// fraction). So a band holds its top edge but not its lower one: an edge shared with the band below belongs
// to that band, and when it is a whole number the chaos search starts 0.01c above it (1c listings come only
// from the "up to 1c" band, not again at the top of the next band's ids). A band with no whole chaos price
// above its lower edge (1c to 1.67c on a 5c budget) would only repeat the band below, so its edge is dropped
// and it merges into the next band; an over-budget band with no whole price in it is left out. The divine
// searches keep the shared edges (rounded outwards); the run skips ids it has already fetched.

import type { PriceFilter, PriceOption } from '@poe-upgrade-finder/trade';
import type { BandRole, SearchDepth } from '@poe-upgrade-finder/vocab';

export interface PriceBand {
    readonly id: string;
    /** "1c to 33c". */
    readonly label: string;
    /** Undefined: no lower edge. */
    readonly minChaos: number | undefined;
    /** True when minChaos is the top of the band below, so it belongs to that band, not this one. */
    readonly minExclusive: boolean;
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

/** Listings scored per band (PLAN: Thorough 100, Normal 50, Quick 20). */
export const DEPTH_PER_BAND: Readonly<Record<SearchDepth, number>> = { thorough: 100, normal: 50, quick: 20 };

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Whole chaos from 10c up, two decimals under (1.67c matters, 236.61c doesn't). */
export function roundEdge(n: number): number {
    return n >= 10 ? Math.round(n) : round2(n);
}

/** Whether some whole chaos price lies in the range (lo, hi], or [lo, hi] when lo is inclusive. */
function holdsWholePrice(lo: number, hi: number, loInclusive: boolean): boolean {
    const first: number = loInclusive ? Math.ceil(lo) : Math.floor(lo) + 1;
    return first <= hi;
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
    // Each band after the first must hold a whole chaos price the bands below don't (#57).
    const edges: number[] = [];
    // Above the last edge, or from the min (inclusive); the first band, with no lower edge, always counts.
    const holdsNewPrice = (hi: number): boolean => {
        const lo: number | undefined = edges[edges.length - 1];
        if (lo !== undefined) {
            return holdsWholePrice(lo, hi, false);
        }
        return min === undefined || holdsWholePrice(min, hi, true);
    };
    for (const e of [floor, ...fractions.map((f: number) => f * budgetChaos)]) {
        const edge: number = roundEdge(e);
        if (
            edge >= floor &&
            edge > (edges[edges.length - 1] ?? 0) &&
            edge < budget &&
            (min === undefined || edge > min) &&
            holdsNewPrice(edge)
        ) {
            edges.push(edge);
        }
    }
    // No whole price between the last edge and the budget: that band merges into the one below.
    if (edges.length > 0 && !holdsNewPrice(budget)) {
        edges.pop();
    }
    edges.push(budget);
    const bands: PriceBand[] = [];
    let previous: number | undefined = min;
    for (const edge of edges) {
        bands.push({
            id: `band-${bands.length + 1}`,
            label: previous === undefined ? `up to ${chaosLabel(edge)}` : `${chaosLabel(previous)} to ${chaosLabel(edge)}`,
            minChaos: previous,
            minExclusive: previous !== undefined && previous !== min,
            maxChaos: edge,
            role: 'main',
        });
        previous = edge;
    }
    const top: number = roundEdge(budgetChaos * overFactor);
    if (overFactor > 1 && holdsWholePrice(budget, top, false)) {
        bands.push({
            id: 'over',
            label: `${chaosLabel(budget)} to ${chaosLabel(top)} (slightly over budget)`,
            minChaos: budget,
            minExclusive: true,
            maxChaos: top,
            role: 'over',
        });
    }
    return bands;
}

export interface BandSearch {
    readonly bandId: string;
    readonly option: PriceOption;
    readonly price: PriceFilter;
}

/**
 * The searches for one band. A whole-chaos lower edge that belongs to the band below is searched from 0.01c above
 * it (prices are whole chaos, #57). Divine edges are 2 decimals: the max rounds up, an inclusive min rounds down,
 * and an exclusive min (the edge belongs to the band below) is the next 2-decimal price above it, so a listing at
 * exactly a whole-divine budget isn't fetched by the over band too (#111). Without a divine rate only the chaos
 * search runs (the caller warns that divine-priced listings are missed). Where rounding still lets a listing
 * into a band it isn't priced for, its role comes from its price (priceRole), not the band.
 */
export function bandSearches(band: PriceBand, chaosPerDivine: number | undefined): BandSearch[] {
    const chaosMin: number | undefined =
        band.minChaos !== undefined && band.minExclusive && Number.isInteger(band.minChaos) ? round2(band.minChaos + 0.01) : band.minChaos;
    const chaos: PriceFilter =
        chaosMin === undefined ? { max: band.maxChaos, option: 'chaos' } : { min: chaosMin, max: band.maxChaos, option: 'chaos' };
    const searches: BandSearch[] = [{ bandId: band.id, option: 'chaos', price: chaos }];
    if (chaosPerDivine !== undefined && chaosPerDivine > 0 && band.maxChaos >= chaosPerDivine) {
        const max: number = Math.ceil((band.maxChaos / chaosPerDivine) * 100) / 100;
        const divine: PriceFilter =
            band.minChaos === undefined
                ? { max: max, option: 'divine' }
                : { min: divineMin(band.minChaos / chaosPerDivine, band.minExclusive), max: max, option: 'divine' };
        searches.push({ bandId: band.id, option: 'divine', price: divine });
    }
    return searches;
}

/** A band's lower edge in divines, to 2 decimals (the site's search takes a min as "at least"). */
function divineMin(divines: number, exclusive: boolean): number {
    // A whisker under the cent, so float noise (300 / 150 = 2.0000000001) doesn't move a whole price.
    const cents: number = divines * 100;
    if (!exclusive) {
        return Math.floor(cents + 1e-9) / 100;
    }
    const whole: number = Math.round(cents);
    return (Math.abs(cents - whole) < 1e-9 ? whole + 1 : Math.ceil(cents)) / 100;
}

/** The run's budget: the top of its in-budget bands; undefined with none. */
export function budgetOf(bands: readonly PriceBand[]): number | undefined {
    const tops: number[] = bands.filter((b: PriceBand) => b.role === 'main').map((b: PriceBand) => b.maxChaos);
    return tops.length === 0 ? undefined : Math.max(...tops);
}

/**
 * Whether a listing is in budget or slightly over (#111): by its chaos price against the budget, whichever band
 * fetched it (divine edges round, so a band can fetch a listing priced just outside it). A listing with no chaos
 * price keeps its band's role.
 */
export function priceRole(chaos: number | undefined, band: PriceBand, budget: number | undefined): BandRole {
    if (chaos === undefined || budget === undefined) {
        return band.role;
    }
    return chaos <= budget ? 'main' : 'over';
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
export function chaosEquivalent(
    price: { readonly amount: number; readonly currency: string } | undefined,
    chaosPerDivine: number | undefined,
): number | undefined {
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
