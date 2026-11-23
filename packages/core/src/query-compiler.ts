// The query compiler (PLAN.md, Trade client, "Query building" and "Complexity budget"): spec + one band
// search → the trade site's search body.
//
// Merge rule: PoB's weighted stats (the spec's weights) as statgroup 0, sorted desc; the spec's
// requirements as an And group; the slot plan's excludes as a Not group and its base as `type`; our
// listing type, category, rarity, level and price filters instead of PoB's; no minimum on the weighted
// sum, no mirrored filter, no empty Not group.
//
// Complexity (V8 and V24, measured, and exact on the live checks): 10 for the filters + 50 + 4 per weighted
// stat + (n + 1) for an And group of n stats + (n + 1) for a Not group of n stats + 1 for `type` + (n + 1)
// for n defence filters (issue #24, measured: 4 filters cost 5), refused over 200. Influence filters aren't
// measured yet and are counted at 1 each. Over budget, the
// lowest-priority weights go first. Requirements, exclusions and the base are never dropped.

import type { DefenceKind, SlotInfluence } from '@poe-upgrade-finder/engine-client';
import type { PriceFilter, SearchFilters, SearchQuery, StatFilter, StatGroup, TradeSearchBody } from '@poe-upgrade-finder/trade';
import type { BandSearch } from './bands.ts';
import type { SearchDefence, SearchExclusion, SearchRequirement, SlotSearchSpec, WeightedStat } from './spec.ts';

export const COMPLEXITY_LIMIT: number = 200;
const FILTERS_COST: number = 10;
const WEIGHT_GROUP_COST: number = 50;
const WEIGHTED_STAT_COST: number = 4;
const TYPE_COST: number = 1;
/** Not measured (V24 didn't send one); assumed like the other single filters. */
const INFLUENCE_COST: number = 1;
/**
 * The site's armour filter for each defence (issue #24, confirmed live on 23 Nov). The site compares Armour,
 * Evasion and ES at 20% quality: listed value × 1.2 / (1 + quality), not the in-game sum with the item's % mods.
 */
export const DEFENCE_FILTERS: Readonly<Record<DefenceKind, string>> = {
    armour: 'ar',
    evasion: 'ev',
    energyShield: 'es',
    ward: 'ward',
};

/** The site's misc filter for each influence (PoB's names → the site's). */
export const INFLUENCE_FILTERS: Readonly<Record<Exclude<SlotInfluence, 'none'>, string>> = {
    shaper: 'shaper_item',
    elder: 'elder_item',
    crusader: 'crusader_item',
    eyrie: 'redeemer_item',
    basilisk: 'hunter_item',
    adjudicator: 'warlord_item',
};

/** The parts of a query beyond the weights and the And group (the slot plan's). */
export interface PlanCost {
    readonly excluded: number;
    readonly typed: boolean;
    readonly influences: number;
    /** Defence filters; missing counts none. */
    readonly defences?: number;
}

const NO_PLAN: PlanCost = { excluded: 0, typed: false, influences: 0 };

export function predictComplexity(weighted: number, required: number, plan: PlanCost = NO_PLAN): number {
    return (
        FILTERS_COST +
        (weighted > 0 ? WEIGHT_GROUP_COST + WEIGHTED_STAT_COST * weighted : 0) +
        (required > 0 ? required + 1 : 0) +
        (plan.excluded > 0 ? plan.excluded + 1 : 0) +
        (plan.typed ? TYPE_COST : 0) +
        INFLUENCE_COST * plan.influences +
        ((plan.defences ?? 0) > 0 ? (plan.defences ?? 0) + 1 : 0)
    );
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

/**
 * The And group's filters: one per stat id. Requirements on the same stat (a hard need on total chaos res and
 * a plan include counting every source) become one filter with the tighter range: both must hold anyway.
 */
export function requirementFilters(requirements: readonly SearchRequirement[]): readonly StatFilter[] {
    const merged: Map<string, { min?: number; max?: number }> = new Map();
    for (const r of requirements) {
        const value: { min?: number; max?: number } = merged.get(r.statId) ?? {};
        if (r.min !== undefined) {
            value.min = value.min === undefined ? r.min : Math.max(value.min, r.min);
        }
        if (r.max !== undefined) {
            value.max = value.max === undefined ? r.max : Math.min(value.max, r.max);
        }
        merged.set(r.statId, value);
    }
    return [...merged].map(([id, value]: [string, { min?: number; max?: number }]) => ({ id: id, value: value }));
}

function influenceFilters(influences: readonly SlotInfluence[]): Record<string, { readonly option: 'true' }> {
    const out: Record<string, { readonly option: 'true' }> = {};
    for (const i of influences) {
        if (i !== 'none') {
            out[INFLUENCE_FILTERS[i]] = { option: 'true' };
        }
    }
    return out;
}

function defenceFilters(defences: readonly SearchDefence[]): Record<string, { readonly min?: number; readonly max?: number }> {
    const out: Record<string, { readonly min?: number; readonly max?: number }> = {};
    for (const d of defences) {
        out[DEFENCE_FILTERS[d.defence]] = {
            ...(d.min === undefined ? {} : { min: d.min }),
            ...(d.max === undefined ? {} : { max: d.max }),
        };
    }
    return out;
}

export function compileQuery(spec: SlotSearchSpec, search: BandSearch, limit: number = COMPLEXITY_LIMIT): CompiledQuery {
    const andFilters: readonly StatFilter[] = requirementFilters(spec.requirements);
    const required: number = andFilters.length;
    const influences: Record<string, { readonly option: 'true' }> = influenceFilters(spec.influences);
    const defences: Record<string, { readonly min?: number; readonly max?: number }> = defenceFilters(spec.defences);
    const plan: PlanCost = {
        excluded: spec.exclusions.length,
        typed: spec.baseType !== null,
        influences: Object.keys(influences).length,
        defences: Object.keys(defences).length,
    };
    const fixed: number = predictComplexity(0, required, plan);
    if (fixed > limit) {
        throw new QueryCompileError(
            `The required stats, excludes, base and defences alone cost ${fixed}, over the complexity limit of ${limit}: remove some from the slot plan`,
        );
    }
    const { kept: weights, dropped } = fitWeights(spec.weights, (n: number) => predictComplexity(n, required, plan) <= limit);
    const stats: StatGroup[] = [];
    // The weighted group stays first: the sort reads statgroup.0.
    if (weights.length > 0) {
        stats.push({
            type: spec.weightGroupType,
            filters: weights.map((w: WeightedStat) => ({ id: w.statId, value: { weight: w.weight } })),
        });
    }
    if (required > 0) {
        stats.push({ type: 'and', filters: andFilters });
    }
    if (spec.exclusions.length > 0) {
        stats.push({ type: 'not', filters: spec.exclusions.map((e: SearchExclusion) => ({ id: e.statId })) });
    }
    const price: PriceFilter = search.price;
    const filters: SearchFilters = {
        type_filters: { filters: { category: { option: spec.category }, rarity: { option: 'nonunique' } } },
        ...(spec.maxLevelRequirement === undefined ? {} : { req_filters: { filters: { lvl: { max: spec.maxLevelRequirement } } } }),
        ...(plan.defences === 0 ? {} : { armour_filters: { filters: defences } }),
        trade_filters: { filters: { price: price } },
        ...(plan.influences === 0 ? {} : { misc_filters: { filters: influences } }),
    };
    const query: SearchQuery = {
        status: { option: spec.listingType },
        ...(spec.baseType === null ? {} : { type: spec.baseType }),
        stats: stats,
        filters: filters,
    };
    const body: TradeSearchBody = {
        query: query,
        // With no weights (PoB found nothing worth weighting) the cheapest come first.
        sort: weights.length > 0 ? { 'statgroup.0': 'desc' } : { price: 'asc' },
    };
    return {
        bandId: search.bandId,
        option: search.option,
        body: body,
        complexity: predictComplexity(weights.length, required, plan),
        weightsUsed: weights.length,
        dropped: dropped,
    };
}

/**
 * The most weights that fit, leaving out the smallest weights first (ties: the later one), so a stat the user
 * boosted in the weight review isn't cut for its position. The kept ones stay in their order; the dropped ones
 * come highest weight first.
 */
function fitWeights(
    weights: readonly WeightedStat[],
    fits: (count: number) => boolean,
): { readonly kept: readonly WeightedStat[]; readonly dropped: readonly WeightedStat[] } {
    let keep: number = weights.length;
    while (keep > 0 && !fits(keep)) {
        keep -= 1;
    }
    if (keep === weights.length) {
        return { kept: weights, dropped: [] };
    }
    const byPriority: number[] = weights.map((_: WeightedStat, i: number) => i);
    byPriority.sort((a: number, b: number) => weightAt(weights, b) - weightAt(weights, a) || a - b);
    const keptIndexes: Set<number> = new Set<number>(byPriority.slice(0, keep));
    return {
        kept: weights.filter((_: WeightedStat, i: number) => keptIndexes.has(i)),
        dropped: byPriority
            .slice(keep)
            .map((i: number) => weights[i])
            .filter((w: WeightedStat | undefined): w is WeightedStat => w !== undefined),
    };
}

function weightAt(weights: readonly WeightedStat[], index: number): number {
    return weights[index]?.weight ?? 0;
}
