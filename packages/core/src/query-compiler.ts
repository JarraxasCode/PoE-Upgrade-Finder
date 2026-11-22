// The query compiler (PLAN.md, Trade client, "Query building" and "Complexity budget"): spec + one band
// search → the trade site's search body.
//
// Merge rule: PoB's weighted stats (the spec's weights) as statgroup 0, sorted desc; the spec's
// requirements as an And group; our listing type, category, rarity, level and price filters instead of
// PoB's; no minimum on the weighted sum, no mirrored filter, no empty Not group.
//
// Complexity (V8, measured, and exact on the live check): 10 for the filters + 50 + 4 per weighted stat +
// (n + 1) for an And group of n stats, refused over 200. Over budget, the lowest-priority weights go first
// (the end of PoB's list, which PoB sorts by gain at a mid roll). Requirements are never dropped.

import type { PriceFilter, SearchFilters, StatFilter, StatGroup, TradeSearchBody } from '@poe-upgrade-finder/trade';
import type { BandSearch } from './bands.ts';
import type { SearchRequirement, SlotSearchSpec, WeightedStat } from './spec.ts';

export const COMPLEXITY_LIMIT: number = 200;
const FILTERS_COST: number = 10;
const WEIGHT_GROUP_COST: number = 50;
const WEIGHTED_STAT_COST: number = 4;

export function predictComplexity(weighted: number, required: number): number {
    return FILTERS_COST + (weighted > 0 ? WEIGHT_GROUP_COST + WEIGHTED_STAT_COST * weighted : 0) + (required > 0 ? required + 1 : 0);
}

export class QueryCompileError extends Error {
    public override readonly name: string = 'QueryCompileError';
}

export interface CompiledQuery {
    readonly bandId: string;
    readonly option: BandSearch['option'];
    readonly body: TradeSearchBody;
    readonly complexity: number;
    readonly weightsUsed: number;
    /** Weights left out to fit the complexity budget, lowest priority last. */
    readonly dropped: readonly WeightedStat[];
}

function requirementFilter(r: SearchRequirement): StatFilter {
    const value: { min?: number; max?: number } = {};
    if (r.min !== undefined) {
        value.min = r.min;
    }
    if (r.max !== undefined) {
        value.max = r.max;
    }
    return { id: r.statId, value: value };
}

export function compileQuery(spec: SlotSearchSpec, search: BandSearch, limit: number = COMPLEXITY_LIMIT): CompiledQuery {
    const required: number = spec.requirements.length;
    if (predictComplexity(0, required) > limit) {
        throw new QueryCompileError(`${required} required stats alone are over the complexity limit of ${limit}`);
    }
    let weights: readonly WeightedStat[] = spec.weights;
    while (weights.length > 0 && predictComplexity(weights.length, required) > limit) {
        weights = weights.slice(0, -1);
    }
    const stats: StatGroup[] = [];
    if (weights.length > 0) {
        stats.push({ type: spec.weightGroupType, filters: weights.map((w: WeightedStat) => ({ id: w.statId, value: { weight: w.weight } })) });
    }
    if (required > 0) {
        stats.push({ type: 'and', filters: spec.requirements.map(requirementFilter) });
    }
    const price: PriceFilter = search.price;
    const filters: SearchFilters = {
        type_filters: { filters: { category: { option: spec.category }, rarity: { option: 'nonunique' } } },
        ...(spec.characterLevel === undefined ? {} : { req_filters: { filters: { lvl: { max: spec.characterLevel } } } }),
        trade_filters: { filters: { price: price } },
    };
    const body: TradeSearchBody = {
        query: { status: { option: spec.listingType }, stats: stats, filters: filters },
        // With no weights (PoB found nothing worth weighting) the cheapest come first.
        sort: weights.length > 0 ? { 'statgroup.0': 'desc' } : { price: 'asc' },
    };
    return {
        bandId: search.bandId,
        option: search.option,
        body: body,
        complexity: predictComplexity(weights.length, required),
        weightsUsed: weights.length,
        dropped: spec.weights.slice(weights.length),
    };
}
