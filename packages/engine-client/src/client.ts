// The engine client the app and the CLI use (PLAN.md, Engine). It owns one worker, keeps the loaded build
// so a worker that dies or hangs can be restarted with the same build, runs one command at a time, and
// splits `score` into small batches so a cancel takes effect between items.

import { EngineError } from './errors.ts';
import { silentLogger } from './logger.ts';
import type { EngineLogger } from './logger.ts';
import { EngineProcess } from './process.ts';
import type { EngineCommand } from './process.ts';
import { readBaseTypes, readSlotData } from './slotdata.ts';
import type { BaseTypeInfo, SlotData } from './slotdata.ts';
import {
    readLoadBuild,
    readPing,
    readScoreItem,
    readScoreSummary,
    readStats,
    readStrip,
    readTradeQuery,
    readTradeQueryProgress,
} from './protocol.ts';
import type {
    CommandName,
    EngineWarning,
    FinalMessage,
    GearSlot,
    LoadBuildData,
    PingData,
    ReadyEvent,
    ScoreItemResult,
    StatsData,
    StreamEvent,
    StripData,
    TargetRequest,
    TradeQueryData,
    TradeQueryProgress,
} from './protocol.ts';
import { messageOf } from '@poe-upgrade-finder/validate';

export interface EngineClientOptions {
    readonly command: EngineCommand;
    readonly logger?: EngineLogger;
    readonly startupTimeoutMs?: number;
    /** Per-command idle timeouts: how long the engine may go without sending anything. */
    readonly idleTimeoutMs?: Partial<Readonly<Record<CommandName, number>>>;
    /** Worker restarts allowed within one score call before it gives up. */
    readonly maxRestartsPerScore?: number;
}

export type WithWarnings<T> = T & { readonly warnings: readonly EngineWarning[] };

export interface CalcOptions {
    readonly target?: TargetRequest;
    readonly extraKeys?: readonly string[];
}

export interface TradeQueryOptions {
    readonly target?: TargetRequest;
    readonly dpsWeight?: number;
    readonly ehpWeight?: number;
    readonly onProgress?: (progress: TradeQueryProgress) => void;
}

export interface ScoreOptions extends CalcOptions {
    /** Items per engine request (default 10). A cancel takes effect at the next batch. */
    readonly batchSize?: number;
    readonly signal?: AbortSignal;
}

export interface ScoreSummary {
    readonly count: number;
    readonly scored: number;
    readonly failed: number;
    /** Items never sent because the run was cancelled. */
    readonly skipped: number;
    readonly cancelled: boolean;
    readonly restarts: number;
    readonly seconds: number;
}

const DEFAULT_IDLE_MS: Readonly<Record<CommandName, number>> = {
    ping: 10_000,
    loadBuild: 120_000,
    stats: 30_000,
    strip: 30_000,
    tradeQuery: 60_000,
    score: 30_000,
    baseTypes: 30_000,
    slotData: 60_000,
    shutdown: 10_000,
};

interface LoadedBuild {
    readonly xml: string;
    readonly name: string | undefined;
    data: LoadBuildData;
}

export class EngineClient {
    private readonly command: EngineCommand;
    private readonly logger: EngineLogger;
    private readonly startupTimeoutMs: number;
    private readonly idleMs: Readonly<Record<CommandName, number>>;
    private readonly maxRestartsPerScore: number;
    private worker: EngineProcess | undefined = undefined;
    private build: LoadedBuild | undefined = undefined;
    private queue: Promise<unknown> = Promise.resolve();
    private workerStarts: number = 0;
    private closed: boolean = false;

    public constructor(options: EngineClientOptions) {
        this.command = options.command;
        this.logger = options.logger ?? silentLogger;
        this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
        this.idleMs = { ...DEFAULT_IDLE_MS, ...options.idleTimeoutMs };
        this.maxRestartsPerScore = options.maxRestartsPerScore ?? 3;
    }

    /** Workers started so far (the first start counts). */
    public get starts(): number {
        return this.workerStarts;
    }

    /** The loaded build as the current worker reported it, if any. */
    public get loaded(): LoadBuildData | undefined {
        return this.build?.data;
    }

    /** Starts the worker if needed (it also starts on the first command). */
    public start(): Promise<ReadyEvent> {
        return this.serial(async () => {
            return (await this.ensureWorker()).ready;
        });
    }

    public ping(): Promise<WithWarnings<PingData>> {
        return this.serial(async () => {
            return this.decode(await this.send('ping', {}), readPing);
        });
    }

    /** Loads a build from its XML (the save's text). It stays loaded across worker restarts. */
    public loadBuild(xml: string, name?: string): Promise<WithWarnings<LoadBuildData>> {
        return this.serial(async () => {
            this.build = undefined;
            const result: WithWarnings<LoadBuildData> = await this.sendLoad(xml, name);
            this.build = { xml: xml, name: name, data: result };
            return result;
        });
    }

    public stats(options: CalcOptions = {}): Promise<WithWarnings<StatsData>> {
        return this.serial(async () => {
            return this.decode(await this.sendForBuild('stats', calcArgs(options)), readStats);
        });
    }

    /** The build's stats with the slot empty. */
    public strip(slot: GearSlot, options: CalcOptions = {}): Promise<WithWarnings<StripData>> {
        return this.serial(async () => {
            return this.decode(await this.sendForBuild('strip', { ...calcArgs(options), slot: slot }), readStrip);
        });
    }

    /** Runs PoB's trade query generator for the slot. */
    public tradeQuery(slot: GearSlot, options: TradeQueryOptions = {}): Promise<WithWarnings<TradeQueryData>> {
        return this.serial(async () => {
            const args: Record<string, unknown> = { slot: slot };
            if (options.target) {
                args['target'] = options.target;
            }
            if (options.dpsWeight !== undefined) {
                args['dpsWeight'] = options.dpsWeight;
            }
            if (options.ehpWeight !== undefined) {
                args['ehpWeight'] = options.ehpWeight;
            }
            const final: FinalMessage = await this.sendForBuild('tradeQuery', args, (event: StreamEvent) => {
                if (event.event === 'progress') {
                    const progress: TradeQueryProgress = readTradeQueryProgress(event.data);
                    options.onProgress?.(progress);
                }
            });
            return this.decode(final, readTradeQuery);
        });
    }

    /** Every PoB item type with bases (Boots, Bow, ...), for picking a base type. Needs no build. */
    public baseTypes(): Promise<WithWarnings<{ readonly types: readonly BaseTypeInfo[] }>> {
        return this.serial(async () => {
            return this.decode(await this.send('baseTypes', {}), readBaseTypes);
        });
    }

    /** What can roll on each base of a PoB item type ("Boots", "Bow"), from PoB's mod data. Needs no build. */
    public slotData(baseType: string): Promise<WithWarnings<SlotData>> {
        return this.serial(async () => {
            return this.decode(await this.send('slotData', { baseType: baseType }), readSlotData);
        });
    }

    /**
     * Scores item texts in the slot, calling onItem once per item in order (index = position in `items`).
     * If the worker dies or hangs, the item it was on is reported as failed, the worker is restarted with
     * the same build, and scoring carries on with the next item.
     */
    public score(
        slot: GearSlot,
        items: readonly string[],
        onItem: (result: ScoreItemResult) => void,
        options: ScoreOptions = {},
    ): Promise<ScoreSummary> {
        return this.serial(async () => {
            const started: number = Date.now();
            const batchSize: number = Math.max(1, options.batchSize ?? 10);
            let next: number = 0;
            let scored: number = 0;
            let failed: number = 0;
            let restarts: number = 0;
            const report = (result: ScoreItemResult): void => {
                if (result.ok) {
                    scored++;
                } else {
                    failed++;
                    this.logger.log('warn', 'item failed to score', {
                        index: result.index,
                        error: result.error,
                        text: items[result.index],
                    });
                }
                onItem(result);
            };
            while (next < items.length) {
                if (options.signal?.aborted) {
                    break;
                }
                const offset: number = next;
                const batch: readonly string[] = items.slice(offset, offset + batchSize);
                let reported: number = 0;
                try {
                    const final: FinalMessage = await this.sendForBuild(
                        'score',
                        { ...calcArgs(options), slot: slot, items: batch },
                        (event: StreamEvent) => {
                            if (event.event !== 'item') {
                                return;
                            }
                            const result: ScoreItemResult = readScoreItem(event.data);
                            if (result.index !== reported) {
                                throw new EngineError('protocol', `score item ${result.index} arrived when ${reported} was expected`);
                            }
                            reported++;
                            report({ ...result, index: offset + result.index });
                        },
                    );
                    this.decode(final, readScoreSummary);
                    if (reported !== batch.length) {
                        throw new EngineError('protocol', `score returned ${reported} of ${batch.length} items`);
                    }
                    next = offset + batch.length;
                } catch (error: unknown) {
                    if (!(error instanceof EngineError) || !error.workerLost) {
                        throw error;
                    }
                    if (reported < batch.length) {
                        // The worker died or hung on item offset + reported: fail that one and go on after it.
                        const lost: number = offset + reported;
                        report({ index: lost, ok: false, error: { code: error.code, message: error.message } });
                        next = lost + 1;
                    } else {
                        // Every item of the batch was reported before the worker went: none failed.
                        next = offset + batch.length;
                    }
                    restarts++;
                    if (restarts > this.maxRestartsPerScore) {
                        throw new EngineError(error.code, `scoring stopped after ${restarts} engine restarts: ${error.message}`);
                    }
                }
            }
            return {
                count: items.length,
                scored: scored,
                failed: failed,
                skipped: items.length - next,
                cancelled: next < items.length,
                restarts: restarts,
                seconds: (Date.now() - started) / 1000,
            };
        });
    }

    /** Stops the worker. The client can't be used afterwards. */
    public shutdown(): Promise<void> {
        return this.serial(async () => {
            this.closed = true;
            const worker: EngineProcess | undefined = this.worker;
            this.worker = undefined;
            if (!worker || !worker.alive) {
                return;
            }
            try {
                await worker.request('shutdown', {}, this.idleMs.shutdown, () => undefined);
            } catch (error: unknown) {
                this.logger.log('warn', 'engine shutdown failed', { error: messageOf(error) });
            }
            await worker.waitForExit(this.idleMs.shutdown);
        });
    }

    // Internals -----------------------------------------------------------------------------------------

    /** Runs commands one at a time, in call order. */
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const run: Promise<T> = this.queue.then(work, work);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** A live worker, started (and given the loaded build again) if the last one is gone. */
    private async ensureWorker(): Promise<EngineProcess> {
        if (this.closed) {
            throw new EngineError('shut-down', 'the engine client has been shut down');
        }
        if (this.worker && this.worker.alive) {
            return this.worker;
        }
        if (this.worker) {
            this.worker.kill('replacing a failed worker');
            this.logger.log('warn', 'restarting the engine worker', { previousPid: this.worker.pid, hasBuild: this.build !== undefined });
        }
        this.worker = undefined;
        const worker: EngineProcess = await EngineProcess.start(this.command, this.logger, this.startupTimeoutMs);
        this.workerStarts++;
        this.worker = worker;
        if (this.build) {
            const build: LoadedBuild = this.build;
            const reloaded: WithWarnings<LoadBuildData> = await this.sendLoad(build.xml, build.name);
            build.data = reloaded;
            this.logger.log('info', 'build reloaded into the new worker', { buildId: reloaded.buildId });
        }
        return worker;
    }

    private async send(
        cmd: CommandName,
        args: Readonly<Record<string, unknown>>,
        onEvent?: (event: StreamEvent) => void,
    ): Promise<FinalMessage> {
        const worker: EngineProcess = await this.ensureWorker();
        this.logger.log('debug', `engine ${cmd}`, { pid: worker.pid });
        return worker.request(cmd, args, this.idleMs[cmd], onEvent ?? ((): void => undefined));
    }

    private async sendLoad(xml: string, name: string | undefined): Promise<WithWarnings<LoadBuildData>> {
        const args: Record<string, unknown> = { xml: xml };
        if (name !== undefined) {
            args['name'] = name;
        }
        this.logger.log('info', 'loading build', { name: name, xmlBytes: xml.length });
        return this.decode(await this.send('loadBuild', args), readLoadBuild);
    }

    private async sendForBuild(
        cmd: CommandName,
        args: Readonly<Record<string, unknown>>,
        onEvent?: (event: StreamEvent) => void,
    ): Promise<FinalMessage> {
        if (!this.build) {
            throw new EngineError('no-build', `${cmd} needs a loaded build`);
        }
        await this.ensureWorker();
        // ensureWorker may have reloaded the build into a new worker, with a new id.
        return this.send(cmd, { ...args, buildId: this.build.data.buildId }, onEvent);
    }

    private decode<T>(final: FinalMessage, read: (data: unknown) => T): WithWarnings<T> {
        if (!final.ok) {
            const error: { readonly code: string; readonly message: string } = final.error ?? {
                code: 'protocol',
                message: 'failed with no error',
            };
            throw new EngineError(error.code, error.message, final.warnings);
        }
        return { ...read(final.data), warnings: final.warnings };
    }
}

function calcArgs(options: CalcOptions): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (options.target) {
        args['target'] = options.target;
    }
    if (options.extraKeys) {
        args['extraKeys'] = options.extraKeys;
    }
    return args;
}
