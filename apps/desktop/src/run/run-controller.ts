// One run at a time from the Search view (PLAN.md, How it works, steps 3 to 7), the same pipeline as the
// headless mode: strip the slot, PoB's trade query, the spec, then runSlotSearch, streaming to the Run view.
//
// The run holds the PoB worker for its whole length (EngineSession.exclusive), so a re-saved build reloads
// only after it ends. Pause stops new trade calls (a fetched batch still finishes scoring); Cancel aborts.
// Buy links are built here from the listing (seller names never reach the renderer), and each click takes
// a search and a fetch slot from the shared limiter first, because the browser's page makes those calls on
// the same account and IP.

import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { shell } from 'electron';
import { buyLink, deepenSlotSearch, generatorWeights, isTradeSiteUrl, priceBands, runSlotSearch, splitDepth, v1SpecBuilder } from '@poe-upgrade-finder/core';
import type { EvaluatedItem, ModCatalog, PobStats, PriceBand, RunEvent, RunResult, RunTrade, SearchRecord, SlotSearchSpec, WeightedStat } from '@poe-upgrade-finder/core';
import { DEPTH_PER_BAND, pobWeightList } from '@poe-upgrade-finder/core';
import type { EngineClient, StripData, TargetRequest, TradeQueryData, WithWarnings } from '@poe-upgrade-finder/engine-client';
import { budgetLabel, parseBudgetText } from '@poe-upgrade-finder/ipc';
import type {
    Budget, BuildSettings, EquippedInfo, FeedEntry, GearSlot, SearchedStat, WeightPreview, FeedLevel, LimitPanel, MainEvent, RunHeader, RunPhase, RunRequest, RunSnapshot, RunSummaryUi, UiItem, UiSearch,
} from '@poe-upgrade-finder/ipc';
import type { JsonlLogger, Logger } from '@poe-upgrade-finder/logging';
import type { FetchResponse, LimiterEvent, SearchResponse, TradePolicy, TradeSearchBody } from '@poe-upgrade-finder/trade';
import { targetRequest } from '../services/build-summary.ts';
import { generatorKey } from '../services/cache-db.ts';
import type { CacheDb } from '../services/cache-db.ts';
import type { EngineSession, LoadedBuild } from '../services/engine-session.ts';
import type { SettingsStore } from '../services/settings-store.ts';
import type { TradeServices } from '../services/trade-services.ts';
import { UserFacingError } from '../ui/ipc-server.ts';
import { PauseGate } from './pause-gate.ts';
import { engineAdapter, pruneRuns, writeRunRecord } from './shared.ts';
import { limitPanel, toUiBand, toUiItem, toUiSearch, toUiSummary } from './ui-mapping.ts';
import type { LimiterWait } from './ui-mapping.ts';

export interface RunControllerOptions {
    readonly userData: string;
    readonly appVersion: string;
    readonly logger: JsonlLogger;
    readonly store: SettingsStore;
    readonly session: EngineSession;
    readonly trade: TradeServices;
    /** The save's full path for a build id, or undefined when it isn't in the Builds folder. */
    readonly buildFile: (buildId: string) => string | undefined;
    readonly emit: (event: MainEvent) => void;
    /** PoB's trade query per build, slot, target and blend (V23). */
    readonly cache: CacheDb;
    /** Development (--replay): recorded listings instead of the trade site; no sign-in, a fixed divine rate. */
    readonly replay?: { readonly trade: RunTrade; readonly chaosPerDivine: number };
}

/** What a finished run keeps so "Search deeper" can extend it. */
interface RunContext {
    readonly spec: SlotSearchSpec;
    readonly bands: readonly PriceBand[];
    readonly target: TargetRequest;
    readonly loaded: LoadedBuild;
    readonly query: TradeQueryData;
    readonly chaosPerDivine: number | undefined;
    readonly settings: BuildSettings;
    readonly request: RunRequest;
    readonly result: RunResult;
    readonly finishedMs: number;
}

/** Ids older than this weren't tested to still fetch (V16); a deeper pass past it says so in the feed. */
const IDS_TESTED_MS: number = 15 * 60_000;

interface RunState {
    header: RunHeader;
    phase: RunPhase;
    searches: UiSearch[];
    readonly items: UiItem[];
    readonly evaluated: Map<string, EvaluatedItem>;
    readonly bandsDone: string[];
    readonly feed: FeedEntry[];
    summary: RunSummaryUi | null;
    readonly abort: AbortController;
    readonly gate: PauseGate;
    context: RunContext | undefined;
    /** PoB's stats for the build as it is, for each find's stat changes. */
    readonly baseline: PobStats;
}

const FEED_MAX: number = 300;
const LIMIT_PUSH_MS: number = 1000;

function stamp(ms: number): string {
    return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class RunController {
    private readonly options: RunControllerOptions;
    private run: RunState | undefined = undefined;
    private wait: LimiterWait | undefined = undefined;
    private limitTimer: ReturnType<typeof setInterval> | undefined = undefined;
    /** A start or deepen is getting ready (sign-in, rate, PoB, the worker lock): no run state exists yet. */
    private preparing: boolean = false;
    /** Cancel while preparing aborts this; a started run keeps it as its own abort. */
    private prepAbort: AbortController | undefined = undefined;

    public constructor(options: RunControllerOptions) {
        this.options = options;
        options.trade.onLimiter((event: LimiterEvent<TradePolicy>) => {
            this.onLimiter(event);
        });
    }

    public get busy(): boolean {
        const phase: RunPhase | undefined = this.run?.phase;
        return this.preparing || phase === 'preparing' || phase === 'searching' || phase === 'paused';
    }

    /** Busy from the first await until the run reads 'searching' (or the start fails): no second start meanwhile. */
    private async whilePreparing(work: (prep: AbortController) => Promise<RunHeader>): Promise<RunHeader> {
        const prep: AbortController = new AbortController();
        this.preparing = true;
        this.prepAbort = prep;
        try {
            return await work(prep);
        } finally {
            this.preparing = false;
            this.prepAbort = undefined;
        }
    }

    /** Between preparation steps: a Cancel pressed while the run was getting ready ends it here. */
    private checkPrepCancelled(prep: AbortController): void {
        if (prep.signal.aborted) {
            throw new UserFacingError('Cancelled before the search started.');
        }
    }

    /** The build the worker holds now must still be the one the run measured (a reload can land before the lock). */
    private checkStillLoaded(loaded: LoadedBuild, prep: AbortController): void {
        this.checkPrepCancelled(prep);
        if (this.options.session.loaded !== loaded) {
            throw new UserFacingError('The build was reloaded while the run was getting ready: start the search again.');
        }
    }

    public snapshot(): RunSnapshot | null {
        const r: RunState | undefined = this.run;
        if (r === undefined) {
            return null;
        }
        return { header: r.header, phase: r.phase, searches: r.searches, items: r.items, bandsDone: r.bandsDone, feed: r.feed, summary: r.summary };
    }

    public limits(): LimitPanel {
        return limitPanel(this.options.trade.limiter.snapshot(), this.wait, Date.now());
    }

    /** PoB's trade query for the loaded build: from the generator cache (V23), else generated and cached. */
    private async pobQueryFor(client: EngineClient, loaded: LoadedBuild, slot: GearSlot, target: TargetRequest, blend: number, log: Logger): Promise<{ readonly query: TradeQueryData; readonly cached: boolean }> {
        const key: string = generatorKey({ xmlHash: loaded.xmlHash, slot: slot, target: target, blend: blend, pobVersion: loaded.load.pobVersion });
        const cached: TradeQueryData | undefined = this.options.cache.generator(key);
        if (cached !== undefined) {
            log.log('info', 'trade query from the cache', { key: key });
            return { query: cached, cached: true };
        }
        const fresh: WithWarnings<TradeQueryData> = await client.tradeQuery(slot, { target: target, ...generatorWeights(blend) });
        if (fresh.queryError === undefined) {
            this.options.cache.saveGenerator(key, fresh);
        }
        log.log('info', 'trade query generated', { key: key, seconds: fresh.seconds, warnings: fresh.warnings.length });
        return { query: fresh, cached: false };
    }

    /** The weight review list for the Search view: PoB's weights for the build, slot and target, named. */
    public async previewWeights(buildId: string, slot: GearSlot, targetId: string): Promise<WeightPreview> {
        const file: string | undefined = this.options.buildFile(buildId);
        if (file === undefined) {
            throw new UserFacingError(`That build isn't in the Builds folder any more: ${buildId}`);
        }
        const settings: BuildSettings = this.options.store.buildSettings(buildId);
        const catalog: ModCatalog | undefined = await this.options.trade.catalog(this.options.replay !== undefined);
        const loaded: LoadedBuild = await this.options.session.ensure(buildId, file, targetId);
        const target: TargetRequest = targetRequest(targetId);
        const log: Logger = this.options.logger.area('run');
        const result = await this.options.session.exclusive((client: EngineClient) => this.pobQueryFor(client, loaded, slot, target, settings.blend, log));
        if (result.query.queryError !== undefined) {
            throw new UserFacingError(`PoB couldn't build the search for ${slot}: ${result.query.queryError}`);
        }
        const weights: SearchedStat[] = pobWeightList(result.query)
            .sort((a: WeightedStat, b: WeightedStat) => b.weight - a.weight)
            .map((w: WeightedStat) => ({ statId: w.statId, label: catalog?.describe(w.statId) ?? w.statId, weight: w.weight }));
        return { buildId: buildId, slot: slot, target: targetId, weights: weights, cached: result.cached };
    }

    /** Prepares the run (sign-in, rate, PoB) and starts it; resolves with its header once searching begins. */
    public async start(request: RunRequest): Promise<RunHeader> {
        if (this.busy) {
            throw new UserFacingError('A run is already going. Cancel it first.');
        }
        return this.whilePreparing((prep: AbortController) => this.prepareAndStart(request, prep));
    }

    private async prepareAndStart(request: RunRequest, prep: AbortController): Promise<RunHeader> {
        const { trade, store, session } = this.options;
        const budget: Budget | undefined = parseBudgetText(request.budget);
        if (budget === undefined) {
            throw new UserFacingError('Type a budget: chaos (300c) or divines (1.5d).');
        }
        const file: string | undefined = this.options.buildFile(request.buildId);
        if (file === undefined) {
            throw new UserFacingError(`That build isn't in the Builds folder any more: ${request.buildId}`);
        }
        const replay = this.options.replay;
        if (replay === undefined) {
            const signIn = trade.signInState.status === 'signed-in' ? trade.signInState : await trade.check();
            if (signIn.status !== 'signed-in') {
                throw new UserFacingError(signIn.status === 'error' ? `Couldn't check the sign-in: ${signIn.message ?? ''}` : 'Not signed in to pathofexile.com: sign in first.');
            }
        }
        this.checkPrepCancelled(prep);
        const chaosPerDivine: number | undefined = replay?.chaosPerDivine ?? (await trade.chaosPerDivine());
        this.checkPrepCancelled(prep);
        if (budget.unit === 'divine' && chaosPerDivine === undefined) {
            throw new UserFacingError('A budget in divines needs a divine rate: type one in, or give the budget in chaos.');
        }
        const budgetChaos: number = budget.unit === 'chaos' ? budget.amount : budget.amount * (chaosPerDivine ?? 0);
        const minBudget: Budget | undefined = request.minBudget === '' ? undefined : parseBudgetText(request.minBudget);
        if (minBudget !== undefined && minBudget.unit === 'divine' && chaosPerDivine === undefined) {
            throw new UserFacingError('A min price in divines needs a divine rate: type one in, or give it in chaos.');
        }
        const minChaos: number | undefined = minBudget === undefined ? undefined : minBudget.unit === 'chaos' ? minBudget.amount : minBudget.amount * (chaosPerDivine ?? 0);
        if (minChaos !== undefined && minChaos >= budgetChaos) {
            throw new UserFacingError('The min price must be under the max price.');
        }
        const settings: BuildSettings = store.buildSettings(request.buildId);
        store.saveBuildSettings(request.buildId, { ...settings, lastSlot: request.slot, lastBudget: request.budget, lastMinBudget: request.minBudget === '' ? null : request.minBudget, lastTarget: request.target });
        const league: string = store.settings.league;

        // Names for PoB's weighted stats (the trade site's stat list, cached a week; never fetched in replay mode).
        const catalog: ModCatalog | undefined = await trade.catalog(replay !== undefined);
        this.checkPrepCancelled(prep);
        const loaded: LoadedBuild = await session.ensure(request.buildId, file, request.target);
        this.checkPrepCancelled(prep);
        if (!(loaded.stats.damage > 0)) {
            throw new UserFacingError('The damage target reads 0. Pick the skill to measure under "Measure damage on".');
        }
        const started: number = Date.now();
        const runId: string = `${request.slot.replace(/ /g, '')}-${stamp(started)}`;
        const target: TargetRequest = targetRequest(request.target);

        return new Promise<RunHeader>((resolveHeader: (h: RunHeader) => void, rejectHeader: (e: Error) => void) => {
            let headerSent: boolean = false;
            void session.exclusive(async (client: EngineClient) => {
                const { logger } = this.options;
                logger.startRun(runId);
                const runLog: Logger = logger.area('run');
                try {
                    this.checkStillLoaded(loaded, prep);
                    const stripped: WithWarnings<StripData> = await client.strip(request.slot, { target: target });
                    this.checkPrepCancelled(prep);
                    const query: TradeQueryData = (await this.pobQueryFor(client, loaded, request.slot, target, settings.blend, runLog)).query;
                    this.checkPrepCancelled(prep);
                    const bands: PriceBand[] = priceBands(budgetChaos, minChaos === undefined ? {} : { minChaos: minChaos });
                    const spec: SlotSearchSpec = v1SpecBuilder().build({
                        slot: request.slot,
                        listingType: request.listing,
                        priceBands: bands,
                        characterLevel: loaded.load.info.level,
                        baseline: loaded.stats,
                        stripped: stripped.stats,
                        pobQuery: query,
                        floors: settings.floors,
                        weightEdits: settings.weightEdits[request.slot],
                    });
                    const header: RunHeader = {
                        runId: runId,
                        buildId: request.buildId,
                        buildName: basename(file).replace(/\.xml$/i, ''),
                        slot: request.slot,
                        league: league,
                        budgetLabel: minBudget === undefined ? budgetLabel(budget) : `${budgetLabel(minBudget)} to ${budgetLabel(budget)}`,
                        budgetChaos: budgetChaos,
                        targetLabel: loaded.summary.targetLabel,
                        depth: request.depth,
                        perBand: DEPTH_PER_BAND[request.depth],
                        listing: request.listing,
                        minGainPct: settings.minGainPct,
                        blend: settings.blend,
                        chaosPerDivine: chaosPerDivine ?? null,
                        startedAtMs: started,
                        baselineDamage: loaded.stats.damage,
                        baselineEhp: loaded.summary.ehp,
                        currentItem: query.item.name || query.item.base || 'nothing',
                        currentView: loaded.summary.equipped.find((e: EquippedInfo) => e.slot === request.slot)?.view ?? null,
                        weightedStats: spec.weights.length,
                        hardNeeds: spec.requirements.map((r) => r.label.replace(/^Required: /, '').replace(/, from strip$/, '')),
                        searchedFor: [...spec.weights]
                            .sort((a: WeightedStat, b: WeightedStat) => b.weight - a.weight)
                            .map((w: WeightedStat) => ({ statId: w.statId, label: catalog?.describe(w.statId) ?? w.statId, weight: w.weight })),
                        bands: bands.map(toUiBand),
                    };
                    const state: RunState = {
                        header: header,
                        phase: 'searching',
                        searches: [],
                        items: [],
                        evaluated: new Map<string, EvaluatedItem>(),
                        bandsDone: [],
                        feed: [],
                        summary: null,
                        abort: prep,
                        gate: new PauseGate(),
                        context: undefined,
                        baseline: loaded.stats,
                    };
                    this.run = state;
                    runLog.log('info', 'run starting', { runId: runId, request: request, league: league, budgetChaos: budgetChaos, minChaos: minChaos ?? null, chaosPerDivine: chaosPerDivine ?? null, floors: settings.floors, blend: settings.blend });
                    this.options.emit({ kind: 'run-started', header: header });
                    this.startLimitPushes();
                    headerSent = true;
                    resolveHeader(header);
                    await this.execute(state, spec, bands, client, target, loaded, query, chaosPerDivine, settings, runLog, request);
                } catch (error: unknown) {
                    const details = { error: messageOf(error), stack: error instanceof Error ? error.stack ?? null : null };
                    if (!headerSent && prep.signal.aborted) {
                        runLog.log('info', 'run cancelled while getting ready', { runId: runId });
                    } else if (!headerSent || this.run === undefined) {
                        runLog.log('error', 'run failed', details);
                    }
                    if (!headerSent) {
                        rejectHeader(error instanceof Error ? error : new Error(String(error)));
                    } else if (this.run !== undefined) {
                        this.feed(this.run, 'error', `The run failed: ${messageOf(error)}`, details);
                        this.setPhase(this.run, 'failed');
                    }
                } finally {
                    this.stopLimitPushes();
                    logger.endRun();
                }
            }).catch((error: unknown) => {
                // The task never ran (no engine client could be made): the caller must still get an answer.
                if (!headerSent) {
                    rejectHeader(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
    }

    public pause(): RunPhase {
        const r: RunState | undefined = this.run;
        if (r !== undefined && r.phase === 'searching') {
            r.gate.pause();
            this.feed(r, 'info', 'Paused: no new searches or fetches until you resume.');
            this.setPhase(r, 'paused');
            this.options.logger.area('ui').log('info', 'run paused', { runId: r.header.runId });
        }
        return r?.phase ?? 'done';
    }

    public resume(): RunPhase {
        const r: RunState | undefined = this.run;
        if (r !== undefined && r.phase === 'paused') {
            r.gate.resume();
            this.feed(r, 'info', 'Resumed.');
            this.setPhase(r, 'searching');
            this.options.logger.area('ui').log('info', 'run resumed', { runId: r.header.runId });
        }
        return r?.phase ?? 'done';
    }

    public cancel(): RunPhase {
        const r: RunState | undefined = this.run;
        if (r !== undefined && (r.phase === 'searching' || r.phase === 'paused')) {
            r.abort.abort();
            this.feed(r, 'info', 'Cancelling…');
            this.options.logger.area('ui').log('info', 'run cancelled by the user', { runId: r.header.runId });
            return r.phase;
        }
        if (this.prepAbort !== undefined && !this.prepAbort.signal.aborted) {
            // Still getting ready (sign-in, rate, PoB, waiting for the worker): it stops at its next step.
            this.prepAbort.abort();
            this.options.logger.area('ui').log('info', 'run cancelled by the user while getting ready');
            return 'cancelled';
        }
        return r?.phase ?? 'done';
    }

    /**
     * Search deeper: the finished run at Thorough depth over the same searches (no new search calls). The build
     * must be unchanged in PoB, so old and new items are scored the same way.
     */
    public async deepen(runId: string): Promise<RunHeader> {
        if (this.busy) {
            throw new UserFacingError('A run is already going.');
        }
        return this.whilePreparing((prep: AbortController) => this.prepareAndDeepen(runId, prep));
    }

    private async prepareAndDeepen(runId: string, prep: AbortController): Promise<RunHeader> {
        const r: RunState | undefined = this.run;
        const ctx: RunContext | undefined = r?.header.runId === runId ? r.context : undefined;
        if (r === undefined || ctx === undefined) {
            throw new UserFacingError("That run can't be searched deeper: start a new search.");
        }
        if (r.phase !== 'done') {
            throw new UserFacingError('Only a run that finished can be searched deeper: start a new search.');
        }
        if (r.header.depth === 'thorough') {
            throw new UserFacingError('This run was already Thorough.');
        }
        if (this.options.replay === undefined) {
            const signIn = this.options.trade.signInState.status === 'signed-in' ? this.options.trade.signInState : await this.options.trade.check();
            if (signIn.status !== 'signed-in') {
                throw new UserFacingError('Not signed in to pathofexile.com: sign in first.');
            }
        }
        const file: string | undefined = this.options.buildFile(ctx.request.buildId);
        if (file === undefined) {
            throw new UserFacingError(`That build isn't in the Builds folder any more: ${ctx.request.buildId}`);
        }
        this.checkPrepCancelled(prep);
        const loaded: LoadedBuild = await this.options.session.ensure(ctx.request.buildId, file, ctx.request.target);
        this.checkPrepCancelled(prep);
        if (loaded.xmlHash !== ctx.loaded.xmlHash) {
            throw new UserFacingError('The build changed in PoB since this run: start a new search, so every item is scored against the same build.');
        }
        const header: RunHeader = { ...r.header, depth: 'thorough', perBand: DEPTH_PER_BAND.thorough };
        const searches: UiSearch[] = deeperPlan(ctx.result.searches, ctx.bands, header.perBand);
        return new Promise<RunHeader>((resolveHeader: (h: RunHeader) => void, rejectHeader: (e: Error) => void) => {
            let headerSent: boolean = false;
            void this.options.session.exclusive(async (client: EngineClient) => {
                const { logger } = this.options;
                logger.startRun(runId);
                const runLog: Logger = logger.area('run');
                try {
                    this.checkStillLoaded(loaded, prep);
                    r.header = header;
                    r.searches = searches;
                    r.bandsDone.length = 0;
                    r.summary = null;
                    r.phase = 'searching';
                    this.options.emit({ kind: 'run-deepen', runId: runId, header: header, searches: searches });
                    this.startLimitPushes();
                    headerSent = true;
                    resolveHeader(header);
                    const extra: number = searches.reduce((a: number, x: UiSearch) => a + x.fetchPlanned, 0) - ctx.result.counts.fetched - ctx.result.counts.missing;
                    this.feed(r, 'info', `Searching deeper: Thorough (${header.perBand} per band) over the same searches, about ${Math.max(0, extra)} more listings, no new searches.`);
                    if (Date.now() - ctx.finishedMs > IDS_TESTED_MS) {
                        this.feed(r, 'warn', 'This run is over 15 minutes old: some listings may be gone from the site.');
                    }
                    runLog.log('info', 'search deeper', { runId: runId, perBand: header.perBand });
                    const labelOf = (bandId: string): string => ctx.bands.find((b: PriceBand) => b.id === bandId)?.label ?? bandId;
                    const started: number = Date.now();
                    const result: RunResult = await deepenSlotSearch(
                        { league: header.league, spec: ctx.spec, baseline: ctx.loaded.stats, blend: ctx.settings.blend, depth: header.perBand, chaosPerDivine: ctx.chaosPerDivine, value: { minGainPct: ctx.settings.minGainPct }, signal: r.abort.signal },
                        ctx.result,
                        this.gatedTrade(r),
                        engineAdapter(client, ctx.request.slot, ctx.target),
                        (event: RunEvent) => {
                            this.onRunEvent(r, event, labelOf, runLog);
                        },
                    );
                    this.complete(r, { ...ctx, request: { ...ctx.request, depth: 'thorough' } }, result, runLog, started);
                } catch (error: unknown) {
                    const details = { error: messageOf(error), stack: error instanceof Error ? error.stack ?? null : null };
                    if (!headerSent) {
                        runLog.log('error', 'search deeper failed', details);
                        // Nothing changed yet: the finished run stays as it was.
                        rejectHeader(error instanceof Error ? error : new Error(String(error)));
                    } else {
                        this.feed(r, 'error', `Search deeper failed: ${messageOf(error)}`, details);
                        this.setPhase(r, 'failed');
                    }
                } finally {
                    this.stopLimitPushes();
                    logger.endRun();
                }
            }).catch((error: unknown) => {
                if (!headerSent) {
                    rejectHeader(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
    }

    /** Opens a listing's buy link in the user's browser. */
    public async openLink(runId: string, itemId: string): Promise<{ readonly opened: boolean; readonly message: string | null }> {
        const r: RunState | undefined = this.run;
        const item: EvaluatedItem | undefined = r?.header.runId === runId ? r.evaluated.get(itemId) : undefined;
        const uiLog: Logger = this.options.logger.area('ui');
        if (r === undefined || item === undefined) {
            return { opened: false, message: 'That listing is from an older run.' };
        }
        const url: string | undefined = buyLink(r.header.league, item.item);
        if (url === undefined || !isTradeSiteUrl(url)) {
            return { opened: false, message: 'This listing has no seller name, so there is no link for it.' };
        }
        // The trade page in the browser makes a search and a fetch on the same account and IP: take both
        // slots from the shared limiter first, so a run can't overrun the limits because of a click.
        const limiter = this.options.trade.limiter;
        await limiter.schedule('search', 'buy link (browser)', () => Promise.resolve());
        await limiter.schedule('fetch', 'buy link (browser)', () => Promise.resolve());
        await shell.openExternal(url);
        // The URL holds the seller's name: logged by item id only.
        uiLog.log('info', 'buy link opened', { runId: runId, itemId: itemId });
        return { opened: true, message: null };
    }

    private async execute(
        state: RunState, spec: SlotSearchSpec, bands: readonly PriceBand[], client: EngineClient, target: TargetRequest, loaded: LoadedBuild,
        query: TradeQueryData, chaosPerDivine: number | undefined, settings: BuildSettings, runLog: Logger, request: RunRequest,
    ): Promise<void> {
        const header: RunHeader = state.header;
        const gated: RunTrade = this.gatedTrade(state);
        if (this.options.replay !== undefined) {
            this.feed(state, 'warn', 'Replay mode: recorded listings, not the live trade site.');
        }
        const labelOf = (bandId: string): string => bands.find((b: PriceBand) => b.id === bandId)?.label ?? bandId;
        this.feed(state, 'info', `Searching ${header.slot}: ${spec.weights.length} weighted stats from PoB${header.hardNeeds.length > 0 ? `, needs ${header.hardNeeds.join(', ')}` : ''}.`);
        const result: RunResult = await runSlotSearch(
            { league: header.league, spec: spec, baseline: loaded.stats, blend: settings.blend, depth: header.perBand, chaosPerDivine: chaosPerDivine, value: { minGainPct: settings.minGainPct }, signal: state.abort.signal },
            gated,
            engineAdapter(client, request.slot, target),
            (event: RunEvent) => {
                this.onRunEvent(state, event, labelOf, runLog);
            },
        );
        this.complete(state, { spec: spec, bands: bands, target: target, loaded: loaded, query: query, chaosPerDivine: chaosPerDivine, settings: settings, request: request, result: result, finishedMs: 0 }, result, runLog, header.startedAtMs);
    }

    /** Pause gate in front of the trade site (or the replay). */
    private gatedTrade(state: RunState): RunTrade {
        const site: RunTrade = this.options.replay?.trade ?? this.options.trade.client;
        return {
            search: async (league: string, body: TradeSearchBody, signal?: AbortSignal): Promise<SearchResponse> => {
                await state.gate.wait(signal);
                return site.search(league, body, signal);
            },
            fetch: async (ids: readonly string[], queryId?: string, signal?: AbortSignal): Promise<FetchResponse> => {
                await state.gate.wait(signal);
                return site.fetch(ids, queryId, signal);
            },
        };
    }

    /** Writes the run record, sends the summary, sets the phase; keeps the context for Search deeper. */
    private complete(state: RunState, ctx: RunContext, result: RunResult, runLog: Logger, passStartedMs: number): void {
        const header: RunHeader = state.header;
        const { loaded, settings, request } = ctx;
        const finished: number = Date.now();
        let runFile: string | null = null;
        try {
            const runsDir: string = join(this.options.userData, 'runs');
            mkdirSync(runsDir, { recursive: true });
            runFile = writeRunRecord(runsDir, {
                runId: header.runId,
                startedMs: header.startedAtMs,
                finishedMs: finished,
                appVersion: this.options.appVersion,
                pobVersion: loaded.load.pobVersion,
                build: basename(loaded.file),
                league: header.league,
                options: { ...request, blend: settings.blend, minGainPct: settings.minGainPct },
                budgetChaos: header.budgetChaos,
                chaosPerDivine: ctx.chaosPerDivine,
                baseline: loaded.stats,
                target: loaded.target,
                currentItem: ctx.query.item,
                spec: ctx.spec,
                result: result,
            });
            pruneRuns(runsDir);
        } catch (error: unknown) {
            runLog.log('warn', 'run file not written', { error: messageOf(error) });
        }
        state.context = { ...ctx, result: result, finishedMs: finished };
        // A run that finished while paused must not leave the gate shut: Search deeper reuses it.
        state.gate.resume();
        state.summary = toUiSummary(result, header.league, state.baseline, finished, passStartedMs, runFile);
        const phase: RunPhase = result.stoppedReason === undefined ? 'done' : result.stoppedReason === 'Cancelled.' ? 'cancelled' : 'stopped';
        if (result.stoppedReason !== undefined && phase === 'stopped') {
            this.feed(state, 'warn', `Stopped early: ${result.stoppedReason}`);
        }
        this.feed(state, 'info', `Done in ${Math.round((finished - passStartedMs) / 1000)} s: ${result.counts.scored} scored. ${result.verdict.note}`);
        runLog.log('info', 'run done', { seconds: (finished - passStartedMs) / 1000, counts: result.counts, verdict: result.verdict.note, stoppedReason: result.stoppedReason ?? null });
        this.options.emit({ kind: 'run-done', runId: header.runId, summary: state.summary });
        this.setPhase(state, phase);
    }

    private onRunEvent(state: RunState, event: RunEvent, labelOf: (bandId: string) => string, runLog: Logger): void {
        const runId: string = state.header.runId;
        switch (event.kind) {
            case 'search': {
                const s: UiSearch = toUiSearch(event.record);
                state.searches.push(s);
                this.options.emit({ kind: 'run-search', runId: runId, search: s });
                runLog.log('info', 'search', { ...event.record, body: undefined, idList: undefined });
                if (s.error === null) {
                    this.feed(state, 'info', `${labelOf(s.bandId)}, ${s.option}: ${s.total ?? 0} listings, scoring ${s.fetchPlanned}.`);
                }
                break;
            }
            case 'item': {
                const item: UiItem = toUiItem(event.item, state.header.league, state.baseline);
                state.items.push(item);
                state.evaluated.set(item.id, event.item);
                this.options.emit({ kind: 'run-item', runId: runId, item: item });
                runLog.log('debug', 'scored', { id: item.id, gain: item.gainPct, floorsPass: item.floorsPass, chaos: item.chaos });
                break;
            }
            case 'warning':
                this.feed(state, 'warn', event.message);
                break;
            case 'item-failed':
                this.feed(state, 'warn', `PoB couldn't score a listing: ${event.message}`, { id: event.listingId, message: event.message });
                break;
            case 'band-done':
                state.bandsDone.push(event.band.id);
                this.options.emit({ kind: 'run-band-done', runId: runId, bandId: event.band.id });
                runLog.log('info', 'band done', { band: event.band.id, fetched: event.fetched, scored: event.scored });
                break;
            case 'skipped':
                runLog.log('debug', 'skipped', { id: event.listingId, reason: event.reason });
                break;
            case 'missing':
                this.feed(state, 'info', `${event.listingIds.length} listing${event.listingIds.length === 1 ? ' was' : 's were'} gone before the fetch.`);
                runLog.log('info', 'gone before fetch', { ids: event.listingIds.length });
                break;
        }
    }

    private onLimiter(event: LimiterEvent<TradePolicy>): void {
        const r: RunState | undefined = this.run;
        const active: boolean = r !== undefined && (r.phase === 'searching' || r.phase === 'paused');
        if (event.kind === 'wait') {
            this.wait = { policy: event.key, untilMs: Date.now() + event.waitMs, reason: event.reason };
            if (active && r !== undefined && event.waitMs >= 2000) {
                this.feed(r, 'info', `Rate limit: waiting ${(event.waitMs / 1000).toFixed(1)} s (${event.key}: ${event.reason}).`);
            }
        } else if (event.kind === 'retry-after' && active && r !== undefined) {
            this.feed(r, 'warn', `The site said wait ${event.seconds} s (429). Waiting, not retrying into it.`);
        } else if (event.kind === 'stop' && active && r !== undefined) {
            this.feed(r, 'error', `Rate limit: a ${Math.round(event.waitMs / 1000)} s wait is too long, so the run stops (${event.reason}).`);
        } else if (event.kind === 'send') {
            this.wait = undefined;
        }
        this.options.emit({ kind: 'limits', panel: this.limits() });
    }

    private startLimitPushes(): void {
        this.stopLimitPushes();
        this.limitTimer = setInterval(() => {
            this.options.emit({ kind: 'limits', panel: this.limits() });
        }, LIMIT_PUSH_MS);
    }

    private stopLimitPushes(): void {
        if (this.limitTimer !== undefined) {
            clearInterval(this.limitTimer);
            this.limitTimer = undefined;
        }
        this.options.emit({ kind: 'limits', panel: this.limits() });
    }

    /**
     * Adds a line to the Run view's activity feed. Warnings and errors are also written to the run's log with
     * the same text, so the feed can link to that line (Settings → Logs, matched by run, text and time).
     */
    private feed(state: RunState, level: FeedLevel, text: string, data?: Readonly<Record<string, unknown>>): void {
        const entry: FeedEntry = { atMs: Date.now(), level: level, text: text };
        if (level !== 'info') {
            this.options.logger.area('run').log(level, text, data);
        }
        state.feed.push(entry);
        if (state.feed.length > FEED_MAX) {
            state.feed.splice(0, state.feed.length - FEED_MAX);
        }
        this.options.emit({ kind: 'run-feed', runId: state.header.runId, entry: entry });
    }

    private setPhase(state: RunState, phase: RunPhase): void {
        state.phase = phase;
        this.options.emit({ kind: 'run-phase', runId: state.header.runId, phase: phase });
    }
}

/** The recorded searches with the fetch plan a deeper depth gives them (what the bands panel shows). */
export function deeperPlan(records: readonly SearchRecord[], bands: readonly PriceBand[], perBand: number): UiSearch[] {
    const planned: Map<SearchRecord, number> = new Map<SearchRecord, number>();
    for (const band of bands) {
        const ok: SearchRecord[] = records.filter((x: SearchRecord) => x.bandId === band.id && x.error === undefined && x.idList.length > 0);
        const counts: number[] = splitDepth(perBand, ok.map((x: SearchRecord) => ({ total: x.total ?? 0, available: x.idList.length })));
        ok.forEach((x: SearchRecord, i: number) => {
            planned.set(x, counts[i] ?? 0);
        });
    }
    return records.map((x: SearchRecord): UiSearch => ({ ...toUiSearch(x), fetchPlanned: planned.get(x) ?? 0 }));
}
