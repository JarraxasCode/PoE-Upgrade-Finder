// The slot search spec (PLAN.md, "Search spec (built in v1, filled in v2)"). One spec per run says what to
// search for, what each item must pass and what to note. The query compiler, the scoring pipeline and the
// UI only read the spec, so new options become new entries in it (from new sources), not new code paths.

import type { GearSlot } from '@poe-upgrade-finder/engine-client';
import type { ItemDisplay, ListingPrice, ListingStatus, StatGroupType } from '@poe-upgrade-finder/trade';
import type { PriceBand } from './bands.ts';
import type { FloorSettings } from './floors.ts';
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
    /** v1 only produces 'strip'. */
    readonly origin: 'strip' | 'user';
    /** For the Run view: "Required: cold res ≥ 41, from strip". */
    readonly label: string;
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
    readonly seller: string | undefined;
    readonly price: ListingPrice | undefined;
    /** The price in chaos at the run's divine rate; undefined for other currencies (flagged, not converted). */
    readonly chaosEquivalent: number | undefined;
    readonly bandId: string;
    /** Tooltip data from the fetch, when the item came from one. */
    readonly display?: ItemDisplay | undefined;
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

export interface SlotSearchSpec {
    readonly slot: SlotId;
    readonly listingType: ListingStatus;
    /** Trade category, from PoB's generator for the slot's item (e.g. "armour.boots"). */
    readonly category: string;
    /** Items must be equippable at this level (req_filters), when known. */
    readonly characterLevel: number | undefined;
    readonly priceBands: readonly PriceBand[];
    readonly requirements: readonly SearchRequirement[];
    /** In priority order (PoB's: by gain at a mid roll). v1: PoB's generator. */
    readonly weights: readonly WeightedStat[];
    readonly weightGroupType: Extract<StatGroupType, 'weight' | 'weight2'>;
    readonly checks: readonly ItemCheck[];
    readonly noters: readonly ItemNoter[];
}

/** Everything a source may read to fill the spec for one run. */
export interface RunContext {
    readonly slot: SlotId;
    readonly listingType: ListingStatus;
    readonly priceBands: readonly PriceBand[];
    readonly characterLevel: number | undefined;
    /** The build as it is (current item equipped), with the run's damage target. */
    readonly baseline: PobStats;
    /** The build with the slot empty. */
    readonly stripped: PobStats;
    readonly pobQuery: PobTradeQuery;
    readonly floors: FloorSettings;
    /**
     * The user's review of the weights before the search (PLAN.md, "Review PoB's weights before searching"):
     * stat id → weight; 0 turns the stat off. Stats not named keep their source's weight.
     */
    readonly weightEdits?: Readonly<Record<string, number>> | undefined;
}

export interface RequirementSource {
    readonly id: string;
    requirementsFor(context: RunContext): readonly SearchRequirement[];
}

export interface WeightSource {
    readonly id: string;
    weightsFor(context: RunContext): readonly WeightedStat[];
}

export interface CheckSource {
    readonly id: string;
    checksFor(context: RunContext): readonly ItemCheck[];
}

export interface NoterSource {
    readonly id: string;
    notersFor(context: RunContext): readonly ItemNoter[];
}

export interface SpecSources {
    readonly requirements: readonly RequirementSource[];
    readonly weights: readonly WeightSource[];
    readonly checks: readonly CheckSource[];
    readonly noters: readonly NoterSource[];
}

/** The JSON-safe form of a spec, saved with each run. */
export interface SavedSpec {
    readonly slot: SlotId;
    readonly listingType: ListingStatus;
    readonly category: string;
    readonly characterLevel: number | undefined;
    readonly priceBands: readonly PriceBand[];
    readonly requirements: readonly SearchRequirement[];
    readonly weights: readonly WeightedStat[];
    readonly weightGroupType: string;
    readonly checks: readonly { readonly id: string; readonly kind: CheckKind; readonly label: string }[];
    readonly noters: readonly string[];
}

export function saveSpec(spec: SlotSearchSpec): SavedSpec {
    return {
        slot: spec.slot,
        listingType: spec.listingType,
        category: spec.category,
        characterLevel: spec.characterLevel,
        priceBands: spec.priceBands,
        requirements: spec.requirements,
        weights: spec.weights,
        weightGroupType: spec.weightGroupType,
        checks: spec.checks.map((c: ItemCheck) => ({ id: c.id, kind: c.kind, label: c.label })),
        noters: spec.noters.map((n: ItemNoter) => n.id),
    };
}

export class SpecBuilder {
    private readonly sources: SpecSources;

    public constructor(sources: SpecSources) {
        this.sources = sources;
    }

    public build(context: RunContext): SlotSearchSpec {
        const requirements: SearchRequirement[] = [];
        for (const source of this.sources.requirements) {
            requirements.push(...source.requirementsFor(context));
        }
        // One weight per stat id: the first source to name it wins (v2 adds sources after PoB's).
        const weights: WeightedStat[] = [];
        const seen: Set<string> = new Set<string>();
        for (const source of this.sources.weights) {
            for (const w of source.weightsFor(context)) {
                if (!seen.has(w.statId)) {
                    seen.add(w.statId);
                    weights.push(w);
                }
            }
        }
        const checks: ItemCheck[] = [];
        for (const source of this.sources.checks) {
            checks.push(...source.checksFor(context));
        }
        const noters: ItemNoter[] = [];
        for (const source of this.sources.noters) {
            noters.push(...source.notersFor(context));
        }
        const edited: WeightedStat[] = applyWeightEdits(weights, context.weightEdits);
        const groupType: string | undefined = context.pobQuery.query.stats.find((g: { readonly type: string }) => g.type === 'weight' || g.type === 'weight2')?.type;
        return {
            slot: context.slot,
            listingType: context.listingType,
            category: context.pobQuery.category.query,
            characterLevel: context.characterLevel,
            priceBands: context.priceBands,
            requirements: requirements,
            weights: edited,
            weightGroupType: groupType === 'weight2' ? 'weight2' : 'weight',
            checks: checks,
            noters: noters,
        };
    }
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

/** The user's edits over the collected weights: a stat set to 0 is dropped, another number replaces the weight. */
export function applyWeightEdits(weights: readonly WeightedStat[], edits: Readonly<Record<string, number>> | undefined): WeightedStat[] {
    if (edits === undefined) {
        return [...weights];
    }
    const out: WeightedStat[] = [];
    for (const w of weights) {
        const e: number | undefined = edits[w.statId];
        if (e === undefined || !Number.isFinite(e)) {
            out.push(w);
        } else if (e > 0) {
            out.push({ ...w, weight: e });
        }
    }
    return out;
}

/** v1's weights: PoB's generated weighted group, in PoB's order, zero weights dropped. */
export const pobWeights: WeightSource = {
    id: 'pob-generator',
    weightsFor(context: RunContext): readonly WeightedStat[] {
        return pobWeightList(context.pobQuery);
    },
};
