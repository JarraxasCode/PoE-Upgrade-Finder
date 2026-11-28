// The per-slot pipeline (PLAN.md, "v2a: the slot plan"): strip → PoB's generator → the spec from the slot
// plan → price bands → search → score, for one slot plan. The run controller calls it once in v0.2; the
// multi-slot batch (v0.4) calls it once per plan over the same limiter and PoB worker.
//
// It runs inside the worker lock (the caller's EngineSession.exclusive) and fetches nothing on its own: the
// slot data and the weights lookup are handed in, so nothing here takes the lock again.

import { buildSlotSpec, runSlotSearch } from '@poe-upgrade-finder/core';
import type {
    PlanCheck,
    PriceBand,
    RunEvent,
    RunResult,
    RunTrade,
    SlotRunInput,
    SlotSearchSpec,
    SlotSpecResult,
} from '@poe-upgrade-finder/core';
import type {
    EngineClient,
    SlotData,
    StripData,
    TargetRequest,
    TradeQueryData,
    UniqueInfo,
    UniquesData,
    WithWarnings,
} from '@poe-upgrade-finder/engine-client';
import type { LoadedBuild } from '../services/engine-session.ts';
import { refuseQueryError } from '../services/weights.ts';
import { UserFacingError } from '../ui/user-facing-error.ts';
import { engineAdapter, planGear } from './shared.ts';
import { isUniquePlan } from '@poe-upgrade-finder/vocab';
import type { FloorSettings, GearSlot, LevelFilter, ListingType, SlotPlan, WeightEdits } from '@poe-upgrade-finder/vocab';
import { pickedUnique, uniqueNotes, uniqueRunQuery } from './unique-run.ts';

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
    readonly weightEdits: WeightEdits | undefined;
    /** The build's level requirement filter (issue #22). */
    readonly levelFilter: LevelFilter;
    /** The weights for the slot (WeightService.weightsFor: PoB's generator, or its cache). */
    readonly weights: (client: EngineClient, slot: GearSlot) => Promise<TradeQueryData>;
    /** The uniques for the slot's item type, for a unique run (UniqueService.uniquesFor, or its cache; #113). */
    readonly uniques: (client: EngineClient, slot: GearSlot, itemType: string) => Promise<UniquesData>;
    /** Between steps: throws when the run was cancelled or the build changed meanwhile. */
    readonly checkpoint: () => void;
}

export interface PreparedSlot {
    readonly spec: SlotSearchSpec;
    readonly query: TradeQueryData;
    readonly stripped: StripData;
    /** The plan's check: notes on what it changed (redundant excludes left out). */
    readonly check: PlanCheck;
    /** A unique run's notes on hard needs the unique has no line for (#113); empty for a rare run. */
    readonly uniqueNotes: readonly string[];
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
    // A unique run weighs the unique's own rolls, so PoB's generator isn't run (#113).
    let unique: UniqueInfo | undefined;
    let query: TradeQueryData;
    if (isUniquePlan(plan) && plan.itemType !== null) {
        const data: UniquesData = await job.uniques(client, slot, plan.itemType);
        unique = pickedUnique(data, plan.unique);
        query = uniqueRunQuery(slot, plan.itemType, data, loaded.load.equipped);
    } else {
        query = await job.weights(client, slot);
        refuseQueryError(slot, query);
    }
    job.checkpoint();
    const built: SlotSpecResult = buildSlotSpec(plan, {
        context: {
            slot: slot,
            listingType: job.listing,
            priceBands: job.bands,
            characterLevel: loaded.load.info.level,
            baseline: loaded.stats,
            stripped: stripped.stats,
            itemTotals: stripped.itemTotals,
            pobQuery: query,
            floors: job.floors,
            weightEdits: job.weightEdits,
            levelFilter: job.levelFilter,
        },
        slotData: job.slotData,
        gear: planGear(loaded.load.equipped),
        ...(unique === undefined ? {} : { unique: unique }),
    });
    if (!built.ok) {
        throw new UserFacingError(`The slot plan can't be searched: ${built.check.problems.map((p) => p.text).join('; ')}.`);
    }
    const notes: readonly string[] = unique === undefined ? [] : uniqueNotes(unique, built.spec.requirements);
    return { spec: built.spec, query: query, stripped: stripped, check: built.check, uniqueNotes: notes };
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
