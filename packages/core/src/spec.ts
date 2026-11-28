// The slot search spec (PLAN.md, "Search spec (built in v1, filled in v2)"). One spec per run says what to
// search for, what each item must pass and what to note. The query compiler, the scoring pipeline and the
// UI only read the spec, so new options become new entries in it (from new sources), not new code paths.

import type {
    BandRole,
    DefenceKind,
    FloorSettings,
    GearSlot,
    ItemView,
    LevelFilter,
    ListingType,
    PickedUnique,
    PruneReason,
    SlotInfluence,
    WeightEdits,
    SocketRange,
    SocketRow,
} from '@poe-upgrade-finder/vocab';
import { applyWeightEdits } from '@poe-upgrade-finder/vocab';
import type { ListingPrice, StatGroupType, StatLine } from '@poe-upgrade-finder/trade';
import type { PriceBand } from './bands.ts';
import type { PobStats } from './stats.ts';

export type SlotId = GearSlot;

export interface WeightedStat {
    /** Trade stat id (explicit, implicit or pseudo). */
    readonly statId: string;
    readonly weight: number;
}

export interface SearchRequirement {
    readonly statId: string;
    readonly min?: number;
    readonly max?: number;
    /** 'strip': the build's hard needs; 'plan': the slot plan's includes (v0.2). */
    readonly origin: 'strip' | 'plan';
    /** For the Run view: "Required: cold res ≥ 41, from strip". */
    readonly label: string;
    /** The site's wording of the stat, when known: tells which way a "reduced" line counts (issue #6). */
    readonly siteText?: string;
    /** The label's range is the negative of the site's (a "reduced" include on an "increased" stat, decision 11). */
    readonly negated?: boolean;
    /** A strip need lowered to what the current item carries (#34): the gap in the build's total it came from. */
    readonly gap?: number;
}

/** The totals the current item carries itself, from PoB's parsed mods (#34): what a strip need is capped at. */
export type ItemTotalKey = 'Chaos' | 'Fire' | 'Cold' | 'Lightning' | 'Str' | 'Dex' | 'Int';
export type ItemTotals = Readonly<Partial<Record<ItemTotalKey, number>>>;

/** A stat no result may have (the slot plan's excludes), compiled to a Not group. */
export interface SearchExclusion {
    readonly statId: string;
    readonly origin: 'plan';
    /** "Excluded: #% increased Rarity of Items found, from plan". */
    readonly label: string;
}

/**
 * A hybrid mod no result may have (the slot plan's hybrid excludes, #38). The site can't filter mods, so nothing
 * goes in the query: a fetched item whose lines for these stats share one mod index in one domain is dropped
 * before scoring (excluded-mods.ts, G19).
 */
export interface SearchModExclusion {
    /** The hybrid's stats, as the slot data lists them: "explicit.stat_4052037485". */
    readonly statIds: readonly string[];
    /** The mod as the editor shows it: "+# to maximum Energy Shield / +# to maximum Mana". */
    readonly name: string;
    readonly origin: 'plan';
    /** "Excluded: +# to maximum Energy Shield / +# to maximum Mana (hybrid mod), from plan". */
    readonly label: string;
}

/** A range on one of the item's defences (the slot plan's, issue #24), compiled to the site's armour filters. */
export interface SearchDefence {
    readonly defence: DefenceKind;
    readonly min?: number;
    readonly max?: number;
    readonly origin: 'plan';
    /** "Energy Shield ≤ 0, from plan". */
    readonly label: string;
}

/** One of the site's socket filter rows (the slot plan's, #58), compiled to socket_filters. */
export interface SearchSockets {
    readonly row: SocketRow;
    readonly range: SocketRange;
    readonly origin: 'plan';
    /** "Links ≥ 5, 3 R, from plan". */
    readonly label: string;
}

export interface PrunedWeight extends WeightedStat {
    readonly reason: PruneReason;
    /** For the weight review: "Sorcerer Boots can't roll it". */
    readonly text: string;
}

export type CheckKind = 'floor' | 'target' | 'flag';

/** pass / fail on PoB's numbers; skipped when the check doesn't apply (and says why). */
export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
    readonly checkId: string;
    readonly kind: CheckKind;
    readonly status: CheckStatus;
    /** "Chaos res ≥ 50: 47 (was 63)". */
    readonly detail: string;
}

export interface ItemCheck {
    readonly id: string;
    readonly kind: CheckKind;
    /** "Chaos res ≥ 50". */
    readonly label: string;
    /** before = the build with the current item; after = with the candidate. */
    evaluate(before: PobStats, after: PobStats): CheckResult;
}

/** A listing as the pipeline sees it. */
export interface ListedItem {
    readonly id: string;
    readonly text: string;
    readonly name: string;
    readonly baseType: string;
    readonly itemLevel: number | undefined;
    /** The item's own mod lines as trade stat ids (for the buy link). */
    readonly statIds: readonly string[];
    /** Every mod line with its stat, implicits included (which lines met the plan); missing when unknown. */
    readonly statLines?: readonly StatLine[] | undefined;
    readonly seller: string | undefined;
    readonly price: ListingPrice | undefined;
    /** The price in chaos at the run's divine rate; undefined for other currencies (flagged, not converted). */
    readonly chaosEquivalent: number | undefined;
    readonly bandId: string;
    /** In budget or slightly over, by price (bands.ts, priceRole), whichever band fetched it. */
    readonly role: BandRole;
    /** Tooltip data from the fetch, when the item came from one. */
    readonly display?: ItemView | undefined;
}

export interface ItemNote {
    readonly noterId: string;
    readonly text: string;
}

export interface ScoredStats {
    readonly stats: PobStats;
    /** Mod lines PoB couldn't parse. */
    readonly unparsed: readonly string[];
}

export interface ItemNoter {
    /** v2: 'eldritch-implicits'. */
    readonly id: string;
    /** Notes only: never changes the item or its score. */
    notesFor(item: ListedItem, scored: ScoredStats): readonly ItemNote[];
}

/** PoB's generated trade query, the part the spec reads (structurally the engine's TradeQueryData). */
export interface PobTradeQuery {
    readonly category: { readonly query: string };
    readonly query: {
        readonly stats: readonly {
            readonly type: string;
            readonly filters: readonly { readonly id: string; readonly weight: number | undefined }[];
        }[];
    };
}

/** What a search returns by rarity: rares (every run but a unique search), or one picked unique (#113). */
export type SearchRarity = 'rare' | 'unique';

export interface SlotSearchSpec {
    readonly slot: SlotId;
    readonly listingType: ListingType;
    readonly rarity: SearchRarity;
    /** The unique searched for (its name and the site's base name go in the query); null: a rare search. */
    readonly unique: PickedUnique | null;
    /** Trade category, from PoB's generator for the slot's item (e.g. "armour.boots"). */
    readonly category: string;
    /** The highest level requirement a result may have (req_filters), from the build's level filter; undefined: none. */
    readonly maxLevelRequirement: number | undefined;
    readonly priceBands: readonly PriceBand[];
    /** The site's name for one base (the slot plan's base); null: any base. */
    readonly baseType: string | null;
    readonly requirements: readonly SearchRequirement[];
    readonly exclusions: readonly SearchExclusion[];
    /** Hybrid mods no result may have: dropped after the fetch, not searched for (#38). */
    readonly modExclusions: readonly SearchModExclusion[];
    /** Ranges on the item's defences (the slot plan's). */
    readonly defences: readonly SearchDefence[];
    /** The site's socket filters (the slot plan's, #58). */
    readonly sockets: readonly SearchSockets[];
    /** Influences the item must have (from the plan's influenced includes), at most two. */
    readonly influences: readonly SlotInfluence[];
    /** In priority order (PoB's: by gain at a mid roll). v1: PoB's generator. After the plan's pruning. */
    readonly weights: readonly WeightedStat[];
    /** Weights the slot plan took out, each with its reason. */
    readonly pruned: readonly PrunedWeight[];
    readonly weightGroupType: Extract<StatGroupType, 'weight' | 'weight2'>;
    readonly checks: readonly ItemCheck[];
    readonly noters: readonly ItemNoter[];
}

export const DEFAULT_LEVEL_FILTER: LevelFilter = { kind: 'character' };

/** The highest level requirement to search for, or undefined for no filter (or an unknown character level). */
export function maxLevelRequirement(characterLevel: number | undefined, filter: LevelFilter = DEFAULT_LEVEL_FILTER): number | undefined {
    switch (filter.kind) {
        case 'off':
            return undefined;
        case 'max':
            return filter.level;
        case 'character':
            return characterLevel;
    }
}

/** Everything a source may read to fill the spec for one run. */
export interface RunContext {
    readonly slot: SlotId;
    readonly listingType: ListingType;
    readonly priceBands: readonly PriceBand[];
    readonly characterLevel: number | undefined;
    /** The level requirement filter; missing: up to the character's level. */
    readonly levelFilter?: LevelFilter | undefined;
    /** The build as it is (current item equipped), with the run's damage target. */
    readonly baseline: PobStats;
    /** The build with the slot empty. */
    readonly stripped: PobStats;
    /** What the current item carries itself; undefined for an empty slot (strip needs are then uncapped). */
    readonly itemTotals?: ItemTotals | undefined;
    readonly pobQuery: PobTradeQuery;
    readonly floors: FloorSettings;
    /**
     * The user's review of the weights before the search (PLAN.md, "Review PoB's weights before searching"):
     * stat id → a factor on the source's weight, or off (vocab's weight-model). Stats not named keep their weight.
     */
    readonly weightEdits?: WeightEdits | undefined;
}

/**
 * What one source adds to a slot's search (PLAN.md, "Search spec"). Every part is optional; composeSpec merges
 * them in source order. The build's sources add needs, weights and checks; the slot plan adds the rest.
 */
export interface SpecContribution {
    readonly requirements?: readonly SearchRequirement[];
    readonly exclusions?: readonly SearchExclusion[];
    readonly modExclusions?: readonly SearchModExclusion[];
    readonly defences?: readonly SearchDefence[];
    readonly sockets?: readonly SearchSockets[];
    readonly influences?: readonly SlotInfluence[];
    /** In priority order; one weight per stat id, the first source to name it wins. */
    readonly weights?: readonly WeightedStat[];
    readonly checks?: readonly ItemCheck[];
    readonly noters?: readonly ItemNoter[];
    /** The trade category, over PoB's (the plan's item type); the last source to set it wins. */
    readonly category?: string;
    /** The site's name for one base; the last source to set it wins. */
    readonly baseType?: string;
    /** The last source to set it wins; none: rare. */
    readonly rarity?: SearchRarity;
    /** The unique to search for; the last source to set it wins. */
    readonly unique?: PickedUnique;
    /** Takes weights out of the merged list, before the user's edits (the slot plan's pruning, by stat). */
    readonly prune?: (weights: readonly WeightedStat[]) => {
        readonly kept: readonly WeightedStat[];
        readonly pruned: readonly PrunedWeight[];
    };
}

export interface SpecSource {
    readonly id: string;
    contribute(context: RunContext): SpecContribution;
}

/** The spec from the run's context and its sources, in order. */
export function composeSpec(context: RunContext, sources: readonly SpecSource[]): SlotSearchSpec {
    const parts: readonly SpecContribution[] = sources.map((s: SpecSource) => s.contribute(context));
    const all = <T>(pick: (c: SpecContribution) => readonly T[] | undefined): T[] => parts.flatMap((c: SpecContribution) => pick(c) ?? []);
    // One weight per stat id: the first source to name it wins.
    const weights: WeightedStat[] = [];
    const seen: Set<string> = new Set<string>();
    for (const w of all((c: SpecContribution) => c.weights)) {
        if (!seen.has(w.statId)) {
            seen.add(w.statId);
            weights.push(w);
        }
    }
    // The plan prunes first, then the edits apply: the same order as the weight review, so the pruned list
    // holds the source's weights and an off stat the plan takes out reads as pruned in both (#111).
    let kept: readonly WeightedStat[] = weights;
    const pruned: PrunedWeight[] = [];
    for (const c of parts) {
        if (c.prune !== undefined) {
            const result = c.prune(kept);
            kept = result.kept;
            pruned.push(...result.pruned);
        }
    }
    kept = applyWeightEdits(kept, context.weightEdits);
    const last = <T>(pick: (c: SpecContribution) => T | undefined): T | undefined =>
        parts.reduce((found: T | undefined, c: SpecContribution) => pick(c) ?? found, undefined);
    const groupType: string | undefined = context.pobQuery.query.stats.find(
        (g: { readonly type: string }) => g.type === 'weight' || g.type === 'weight2',
    )?.type;
    return {
        slot: context.slot,
        listingType: context.listingType,
        rarity: last((c: SpecContribution) => c.rarity) ?? 'rare',
        unique: last((c: SpecContribution) => c.unique) ?? null,
        category: last((c: SpecContribution) => c.category) ?? context.pobQuery.category.query,
        maxLevelRequirement: maxLevelRequirement(context.characterLevel, context.levelFilter),
        priceBands: context.priceBands,
        baseType: last((c: SpecContribution) => c.baseType) ?? null,
        requirements: all((c: SpecContribution) => c.requirements),
        exclusions: all((c: SpecContribution) => c.exclusions),
        modExclusions: all((c: SpecContribution) => c.modExclusions),
        defences: all((c: SpecContribution) => c.defences),
        sockets: all((c: SpecContribution) => c.sockets),
        influences: all((c: SpecContribution) => c.influences),
        weights: kept,
        pruned: pruned,
        weightGroupType: groupType === 'weight2' ? 'weight2' : 'weight',
        checks: all((c: SpecContribution) => c.checks),
        noters: all((c: SpecContribution) => c.noters),
    };
}

/** The JSON-safe form of a spec, saved with each run. */
export interface SavedSpec {
    readonly slot: SlotId;
    readonly listingType: ListingType;
    readonly rarity: SearchRarity;
    readonly unique: PickedUnique | null;
    readonly category: string;
    readonly maxLevelRequirement: number | undefined;
    readonly priceBands: readonly PriceBand[];
    readonly baseType: string | null;
    readonly requirements: readonly SearchRequirement[];
    readonly exclusions: readonly SearchExclusion[];
    readonly modExclusions: readonly SearchModExclusion[];
    readonly defences: readonly SearchDefence[];
    readonly sockets: readonly SearchSockets[];
    readonly influences: readonly SlotInfluence[];
    readonly weights: readonly WeightedStat[];
    readonly pruned: readonly PrunedWeight[];
    readonly weightGroupType: string;
    readonly checks: readonly { readonly id: string; readonly kind: CheckKind; readonly label: string }[];
    readonly noters: readonly string[];
}

export function saveSpec(spec: SlotSearchSpec): SavedSpec {
    return {
        slot: spec.slot,
        listingType: spec.listingType,
        rarity: spec.rarity,
        unique: spec.unique,
        category: spec.category,
        maxLevelRequirement: spec.maxLevelRequirement,
        priceBands: spec.priceBands,
        baseType: spec.baseType,
        requirements: spec.requirements,
        exclusions: spec.exclusions,
        modExclusions: spec.modExclusions,
        defences: spec.defences,
        sockets: spec.sockets,
        influences: spec.influences,
        weights: spec.weights,
        pruned: spec.pruned,
        weightGroupType: spec.weightGroupType,
        checks: spec.checks.map((c: ItemCheck) => ({ id: c.id, kind: c.kind, label: c.label })),
        noters: spec.noters.map((n: ItemNoter) => n.id),
    };
}

/** PoB's generated weighted group, in PoB's order, zero weights dropped (also the Search view's review list). */
export function pobWeightList(query: PobTradeQuery): WeightedStat[] {
    const out: WeightedStat[] = [];
    for (const group of query.query.stats) {
        if (group.type !== 'weight' && group.type !== 'weight2') {
            continue;
        }
        for (const f of group.filters) {
            if (f.weight !== undefined && f.weight !== 0 && Number.isFinite(f.weight)) {
                out.push({ statId: f.id, weight: f.weight });
            }
        }
    }
    return out;
}

/** The build's weights: PoB's generated weighted group, in PoB's order, zero weights dropped. */
export const pobWeights: SpecSource = {
    id: 'pob-generator',
    contribute(context: RunContext): SpecContribution {
        return { weights: pobWeightList(context.pobQuery) };
    },
};
