// The weights a search is built on (issue #47): PoB's trade query per build, slot, damage target and blend, from
// the generator cache (V23: PoB's weights vary from worker to worker, so one result is cached and reused), else
// generated and cached. Plus the weight review the Search view shows before a run (`weights.preview`).
//
// `weightsFor` runs inside a worker lock its caller already holds (a run). `preview` takes the lock itself,
// so never call it from inside another exclusive task: it would wait on itself.
//
// v0.3 adds our own generator as another WeightSource: `weightsFor` routes on the source and caches each under
// its own key, and each weight set becomes its own SpecSource in the spec builder.

import { analysePlan, generatorWeights, pobWeightList } from '@poe-upgrade-finder/core';
import type { AnalysedPlan, ModCatalog, PlanCheck, PlanGear, PrunedWeight, WeightedStat } from '@poe-upgrade-finder/core';
import type { SlotData, TargetRequest, TradeQueryData, TradeQueryOptions, WithWarnings } from '@poe-upgrade-finder/engine-client';
import type { PrunedStat, SearchedStat, WeightPreview } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { emptySlotPlan } from '@poe-upgrade-finder/vocab';
import type { GearSlot, SlotPlan, WeightSource } from '@poe-upgrade-finder/vocab';
import { UserFacingError } from '../ui/user-facing-error.ts';
import { targetRequest } from './build-summary.ts';
import { generatorKey } from './cache-db.ts';
import { readSave } from './engine-session.ts';

/** The cache rows the service reads and writes (CacheDb). */
export interface WeightCache {
    generator(key: string): TradeQueryData | undefined;
    saveGenerator(key: string, data: TradeQueryData): void;
}

/** The engine call the service makes (EngineClient). */
export interface WeightEngine {
    tradeQuery(slot: GearSlot, options?: TradeQueryOptions): Promise<WithWarnings<TradeQueryData>>;
}

/** What the cache key needs from a loaded build (LoadedBuild). */
export interface WeightBuild {
    /** sha1 of the save's text: any edit in PoB is a new key. */
    readonly xmlHash: string;
    readonly load: { readonly pobVersion: string };
}

/** The parts of EngineSession the preview uses. */
export interface WeightSession {
    readonly loaded: WeightBuild | undefined;
    ensure(buildId: string, file: string, targetId: string): Promise<WeightBuild>;
    exclusive<T>(task: (client: WeightEngine) => Promise<T>): Promise<T>;
    /** The PoB version the worker will report, without starting it; null when unknown. */
    expectedPobVersion(): string | null;
}

export interface WeightRequest {
    readonly slot: GearSlot;
    readonly target: TargetRequest;
    /** DPS against EHP for PoB's generator (BuildSettings.blend). */
    readonly blend: number;
    readonly source: WeightSource;
}

export interface Weights {
    readonly query: TradeQueryData;
    /** Whether it came from the cache (the review says so). */
    readonly cached: boolean;
}

export interface WeightServiceOptions {
    readonly cache: WeightCache;
    readonly session: WeightSession;
    /** The save's full path for a build id, or undefined when it isn't in the Builds folder. */
    readonly buildFile: (buildId: string) => string | undefined;
    /** The build's blend (its settings). */
    readonly blend: (buildId: string) => number;
    /** Names for the trade stats (the site's stat list), when known. */
    readonly catalog: () => Promise<ModCatalog | undefined>;
    /** The slot data a plan needs (planSlotData), undefined for an empty plan. */
    readonly slotData: (plan: SlotPlan) => Promise<SlotData | undefined>;
    /** The build's weapons for the weapon-hand rules (#39); undefined when not known yet. */
    readonly gear?: (buildId: string) => PlanGear | undefined;
    readonly logger: Logger;
}

export class WeightService {
    private readonly options: WeightServiceOptions;

    public constructor(options: WeightServiceOptions) {
        this.options = options;
    }

    /** The weights for the loaded build, under a worker lock the caller holds: from the cache, else generated and cached. */
    public async weightsFor(client: WeightEngine, loaded: WeightBuild, request: WeightRequest): Promise<Weights> {
        const key: string = this.keyFor(loaded.xmlHash, loaded.load.pobVersion, request);
        const cached: TradeQueryData | undefined = this.options.cache.generator(key);
        if (cached !== undefined) {
            this.options.logger.log('info', 'trade query from the cache', { key: key });
            return { query: cached, cached: true };
        }
        const fresh: WithWarnings<TradeQueryData> = await client.tradeQuery(request.slot, {
            target: request.target,
            ...generatorWeights(request.blend),
        });
        if (fresh.queryError === undefined) {
            this.options.cache.saveGenerator(key, fresh);
        }
        this.options.logger.log('info', 'trade query generated', { key: key, seconds: fresh.seconds, warnings: fresh.warnings.length });
        return { query: fresh, cached: false };
    }

    /**
     * The weight review list for the Search view: the weights for the build, slot and target, named. With a slot
     * plan, also which of them the plan takes out and why, and whether the plan can be searched.
     */
    public async preview(buildId: string, slot: GearSlot, targetId: string, plan: SlotPlan | null): Promise<WeightPreview> {
        const file: string | undefined = this.options.buildFile(buildId);
        if (file === undefined) {
            throw new UserFacingError(`That build isn't in the Builds folder any more: ${buildId}`);
        }
        const catalog: ModCatalog | undefined = await this.options.catalog();
        const slotData: SlotData | undefined = plan === null ? undefined : await this.options.slotData(plan);
        const request: WeightRequest = { slot: slot, target: targetRequest(targetId), blend: this.options.blend(buildId), source: 'pob' };
        const result: Weights = this.fromCacheBeforeLoad(file, request) ?? (await this.afterLoad(buildId, file, targetId, request));
        refuseQueryError(slot, result.query);
        const label = (statId: string): string => catalog?.describe(statId) ?? statId;
        const list: readonly WeightedStat[] = pobWeightList(result.query);
        const weights: SearchedStat[] = [...list]
            .sort((a: WeightedStat, b: WeightedStat) => b.weight - a.weight)
            .map((w: WeightedStat) => ({ statId: w.statId, label: label(w.statId), weight: w.weight }));
        // An empty plan is checked too: Weapon 2 beside a two-hander can't be searched at all (#39).
        const gear: PlanGear | undefined = this.options.gear?.(buildId);
        const review: PlanReview = planReview(plan ?? emptySlotPlan(slot), slotData, list, label, gear);
        return { buildId: buildId, slot: slot, target: targetId, weights: weights, ...review, cached: result.cached };
    }

    private keyFor(xmlHash: string, pobVersion: string, request: WeightRequest): string {
        return generatorKey({
            xmlHash: xmlHash,
            slot: request.slot,
            target: request.target,
            blend: request.blend,
            pobVersion: pobVersion,
            source: request.source,
        });
    }

    /**
     * The weights from the cache for the save as it is on disk now, without waiting for PoB to load it: the same
     * key the loaded path uses (save text, slot, target, blend, PoB version), so the answer is the same.
     */
    private fromCacheBeforeLoad(file: string, request: WeightRequest): Weights | undefined {
        const pobVersion: string | null = this.options.session.expectedPobVersion();
        if (pobVersion === null) {
            return undefined;
        }
        let xmlHash: string;
        try {
            xmlHash = readSave(file).xmlHash;
        } catch {
            return undefined;
        }
        const key: string = this.keyFor(xmlHash, pobVersion, request);
        const cached: TradeQueryData | undefined = this.options.cache.generator(key);
        if (cached === undefined) {
            return undefined;
        }
        this.options.logger.log('info', 'trade query from the cache', { key: key, beforeLoad: true });
        return { query: cached, cached: true };
    }

    private async afterLoad(buildId: string, file: string, targetId: string, request: WeightRequest): Promise<Weights> {
        const { session } = this.options;
        const loaded: WeightBuild = await session.ensure(buildId, file, targetId);
        return session.exclusive((client: WeightEngine) => {
            // Another build can load between ensure() and the lock: the weights would be cached under this
            // build's key but generated on the other one.
            if (session.loaded !== loaded) {
                throw new UserFacingError('The build changed while the weights were loading: pick it again.');
            }
            return this.weightsFor(client, loaded, request);
        });
    }
}

/**
 * PoB's generator said it can't build a search ("found no mods to search for", no item in the slot): the review
 * and the run both refuse it, rather than searching with no weights (#111). Such a result is never cached.
 */
export function refuseQueryError(slot: GearSlot, query: TradeQueryData): void {
    if (query.queryError !== undefined) {
        throw new UserFacingError(`PoB couldn't build the search for ${slot}: ${query.queryError}`);
    }
}

/** What the weight review shows about a slot plan. */
export interface PlanReview {
    readonly pruned: readonly PrunedStat[];
    readonly planProblems: readonly string[];
    readonly planNotes: readonly string[];
}

export const NO_REVIEW: PlanReview = { pruned: [], planProblems: [], planNotes: [] };

/**
 * The plan against the weights (before the user's edits: pruning goes by stat, so it reads the same after
 * them): which weights it takes out and why, heaviest first, or why it can't be searched.
 */
export function planReview(
    plan: SlotPlan,
    slotData: SlotData | undefined,
    weights: readonly WeightedStat[],
    label: (statId: string) => string,
    gear?: PlanGear,
): PlanReview {
    const analysed: AnalysedPlan = analysePlan(plan, plan.slot, slotData, gear);
    const check: PlanCheck = analysed.check;
    if (!check.ok) {
        return { ...NO_REVIEW, planProblems: check.problems.map((p) => p.text) };
    }
    const { pruned } = analysed.prune(weights);
    return {
        pruned: [...pruned]
            .sort((a: PrunedWeight, b: PrunedWeight) => b.weight - a.weight)
            .map((p: PrunedWeight) => ({ statId: p.statId, label: label(p.statId), weight: p.weight, reason: p.reason, text: p.text })),
        planProblems: [],
        planNotes: check.notes.map((n) => n.text),
    };
}
