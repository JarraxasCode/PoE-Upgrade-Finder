// The per-slot pipeline (PLAN.md, "v2a: the slot plan"): strip → PoB's generator → the spec from the slot
// plan → price bands → search → score, for one slot plan. The run controller calls it once in v0.2; the
// multi-slot batch (v0.4) calls it once per plan over the same limiter and PoB worker.
//
// It runs inside the worker lock (the caller's EngineSession.exclusive) and fetches nothing on its own: the
// slot data and the generator lookup are handed in, so nothing here takes the lock again.

import { buildSlotSpec, checkPlan, pruneWeights, runSlotSearch } from '@poe-upgrade-finder/core';
import type {
    FloorSettings,
    PlanCheck,
    PriceBand,
    PrunedWeight,
    RunEvent,
    RunResult,
    RunTrade,
    SlotPlan,
    SlotRunInput,
    SlotSearchSpec,
    SlotSpecResult,
    WeightedStat,
} from '@poe-upgrade-finder/core';
import type {
    EngineClient,
    GearSlot,
    SlotData,
    StripData,
    TargetRequest,
    TradeQueryData,
    WithWarnings,
} from '@poe-upgrade-finder/engine-client';
import type { LevelFilter, ListingType, PrunedStat } from '@poe-upgrade-finder/ipc';
import type { LoadedBuild } from '../services/engine-session.ts';
import { UserFacingError } from '../ui/user-facing-error.ts';
import { engineAdapter } from './shared.ts';

/** One slot's work, fixed before it starts. */
export interface SlotPlanJob {
    readonly plan: SlotPlan;
    /** The slot data for the plan's item type; undefined for an empty plan. */
    readonly slotData: SlotData | undefined;
    readonly loaded: LoadedBuild;
    readonly target: TargetRequest;
    readonly listing: ListingType;
    readonly bands: readonly PriceBand[];
    readonly floors: FloorSettings;
    /** The user's weight review for this slot. */
    readonly weightEdits: Readonly<Record<string, number>> | undefined;
    /** The build's level requirement filter (issue #22). */
    readonly levelFilter: LevelFilter;
    /** PoB's trade query for the slot (the generator, or its cache). */
    readonly pobQuery: (client: EngineClient, slot: GearSlot) => Promise<TradeQueryData>;
    /** Between steps: throws when the run was cancelled or the build changed meanwhile. */
    readonly checkpoint: () => void;
}

export interface PreparedSlot {
    readonly spec: SlotSearchSpec;
    readonly query: TradeQueryData;
    readonly stripped: StripData;
    /** The plan's check: notes on what it changed (redundant excludes left out). */
    readonly check: PlanCheck;
}

/**
 * Strip, generator, spec: everything before the first search. A plan that can't be searched is a user-facing
 * error. The plan's item type may differ from the equipped item's (a Bow on a sword slot): its category is
 * searched, PoB's weights still come from the build, and PoB scores whatever comes back as it is.
 */
export async function prepareSlotPlan(client: EngineClient, job: SlotPlanJob): Promise<PreparedSlot> {
    const { plan, loaded } = job;
    const slot: GearSlot = plan.slot;
    job.checkpoint();
    const stripped: WithWarnings<StripData> = await client.strip(slot, { target: job.target });
    job.checkpoint();
    const query: TradeQueryData = await job.pobQuery(client, slot);
    job.checkpoint();
    const built: SlotSpecResult = buildSlotSpec(plan, {
        context: {
            slot: slot,
            listingType: job.listing,
            priceBands: job.bands,
            characterLevel: loaded.load.info.level,
            baseline: loaded.stats,
            stripped: stripped.stats,
            pobQuery: query,
            floors: job.floors,
            weightEdits: job.weightEdits,
            levelFilter: job.levelFilter,
        },
        slotData: job.slotData,
    });
    if (!built.ok) {
        throw new UserFacingError(`The slot plan can't be searched: ${built.check.problems.map((p) => p.text).join('; ')}.`);
    }
    return { spec: built.spec, query: query, stripped: stripped, check: built.check };
}

export interface SlotPlanRun {
    readonly trade: RunTrade;
    /** Called once the spec is ready, before the first search: the caller sets up its run and returns the search input. */
    readonly onPrepared: (prepared: PreparedSlot) => SlotRunInput;
    readonly onEvent: (event: RunEvent) => void;
}

/** One slot plan, from the strip to the scored results. */
export async function runSlotPlan(
    client: EngineClient,
    job: SlotPlanJob,
    run: SlotPlanRun,
): Promise<{ readonly prepared: PreparedSlot; readonly result: RunResult }> {
    const prepared: PreparedSlot = await prepareSlotPlan(client, job);
    const input: SlotRunInput = run.onPrepared(prepared);
    const result: RunResult = await runSlotSearch(input, run.trade, engineAdapter(client, job.plan.slot, job.target), run.onEvent);
    return { prepared: prepared, result: result };
}

/** What the weight review shows about a slot plan. */
export interface PlanReview {
    readonly pruned: readonly PrunedStat[];
    readonly planProblems: readonly string[];
    readonly planNotes: readonly string[];
}

export const NO_REVIEW: PlanReview = { pruned: [], planProblems: [], planNotes: [] };

/**
 * The plan against PoB's weights (before the user's edits: pruning goes by stat, so it reads the same after
 * them): which weights it takes out and why, heaviest first, or why it can't be searched.
 */
export function planReview(
    plan: SlotPlan,
    slotData: SlotData | undefined,
    weights: readonly WeightedStat[],
    label: (statId: string) => string,
): PlanReview {
    const check: PlanCheck = checkPlan(plan, plan.slot, slotData);
    if (!check.ok) {
        return { ...NO_REVIEW, planProblems: check.problems.map((p) => p.text) };
    }
    const { pruned } = pruneWeights(weights, plan, plan.slot, slotData);
    return {
        pruned: [...pruned]
            .sort((a: PrunedWeight, b: PrunedWeight) => b.weight - a.weight)
            .map((p: PrunedWeight) => ({ statId: p.statId, label: label(p.statId), weight: p.weight, reason: p.reason, text: p.text })),
        planProblems: [],
        planNotes: check.notes.map((n) => n.text),
    };
}
