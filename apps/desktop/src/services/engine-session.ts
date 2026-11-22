// One warm PoB worker for the build chosen on the Search view (PLAN.md, How it works, steps 1 and 2): load
// the save, read the baseline with the chosen damage target, and reload by itself when the save changes.
// Sequences of engine commands (load + stats; later the run's strip + trade query + scoring) run one at a
// time under a lock, so a reload can't land in the middle of a run's preparation.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { EngineClient } from '@poe-upgrade-finder/engine-client';
import type { EngineCommand, LoadBuildData, ResolvedTarget, StatBlock, StatsData, WithWarnings } from '@poe-upgrade-finder/engine-client';
import type { BuildState, BuildSummary, EquippedInfo } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { buildSummary, targetRequest } from './build-summary.ts';
import { itemArt } from './base-art.ts';

export interface LoadedBuild {
    readonly buildId: string;
    readonly file: string;
    readonly targetId: string;
    /** sha1 of the save's text (the generator cache key, V23). */
    readonly xmlHash: string;
    readonly fileModifiedMs: number;
    readonly load: LoadBuildData;
    readonly target: ResolvedTarget;
    readonly stats: StatBlock;
    readonly summary: BuildSummary;
}

export interface EngineSessionOptions {
    /** Throws with a readable message when PoB or the host is missing. */
    readonly command: () => EngineCommand;
    readonly logger: Logger;
    readonly onState: (state: BuildState) => void;
    /** The last known gear per build (cache.sqlite), so the gear layout shows at once while PoB loads. */
    readonly gearCache?: {
        readonly get: (buildId: string) => readonly EquippedInfo[] | undefined;
        readonly save: (buildId: string, items: readonly EquippedInfo[]) => void;
    };
    /** For tests: a client factory. */
    readonly createClient?: (command: EngineCommand, logger: Logger) => EngineClient;
}

export class EngineSession {
    private readonly options: EngineSessionOptions;
    private client: EngineClient | undefined = undefined;
    private lock: Promise<unknown> = Promise.resolve();
    private current: LoadedBuild | undefined = undefined;
    /** The latest selection asked for; an older one that finishes later doesn't overwrite it. */
    private wanted: number = 0;

    public constructor(options: EngineSessionOptions) {
        this.options = options;
    }

    public get loaded(): LoadedBuild | undefined {
        return this.current;
    }

    /** Runs a sequence of engine commands alone (nothing else uses the worker meanwhile). */
    public exclusive<T>(task: (client: EngineClient) => Promise<T>): Promise<T> {
        const run: Promise<T> = this.lock.then(async () => task(this.ensureClient()));
        this.lock = run.catch(() => undefined);
        return run;
    }

    /** Loads a save with a damage target ("saved", "full", "skill:G.A[.P]"). */
    public async select(buildId: string, file: string, targetId: string): Promise<BuildSummary> {
        return (await this.selectLoaded(buildId, file, targetId)).summary;
    }

    /** The build as a run needs it: the loaded one when build, target and save are unchanged, else loaded now. */
    public async ensure(buildId: string, file: string, targetId: string): Promise<LoadedBuild> {
        const now: LoadedBuild | undefined = this.current;
        if (now !== undefined && now.buildId === buildId && now.targetId === targetId && now.file === file) {
            try {
                if (statSync(file).mtimeMs === now.fileModifiedMs) {
                    return now;
                }
            } catch {
                // fall through: load it again (and report the error from there)
            }
        }
        return this.selectLoaded(buildId, file, targetId);
    }

    private cachedGear(buildId: string): readonly EquippedInfo[] | null {
        try {
            return this.options.gearCache?.get(buildId) ?? null;
        } catch {
            return null;
        }
    }

    private saveGear(buildId: string, items: readonly EquippedInfo[]): void {
        try {
            this.options.gearCache?.save(buildId, items);
        } catch (error: unknown) {
            this.options.logger.log('warn', 'gear cache not saved', { error: error instanceof Error ? error.message : String(error) });
        }
    }

    private async selectLoaded(buildId: string, file: string, targetId: string): Promise<LoadedBuild> {
        const ticket: number = ++this.wanted;
        try {
            const loaded: LoadedBuild = await this.exclusive(async (client: EngineClient) => {
                // Said only once the worker is ours: a reload waiting behind a run isn't "loading" all run long.
                if (ticket === this.wanted) {
                    this.options.onState({ kind: 'loading', buildId: buildId, equipped: this.cachedGear(buildId) });
                }
                return this.load(client, buildId, file, targetId);
            });
            if (ticket === this.wanted) {
                this.current = loaded;
                this.options.onState({ kind: 'ready', summary: loaded.summary });
                this.saveGear(buildId, loaded.summary.equipped);
            }
            return loaded;
        } catch (error: unknown) {
            const message: string = error instanceof Error ? error.message : String(error);
            this.options.logger.log('warn', 'build load failed', { buildId: buildId, target: targetId, error: message });
            if (ticket === this.wanted) {
                this.current = undefined;
                this.options.onState({ kind: 'error', buildId: buildId, message: message });
            }
            throw error;
        }
    }

    /** The loaded save changed on disk: load it again with the same target (if it really changed). */
    public async reloadIfChanged(): Promise<void> {
        const now: LoadedBuild | undefined = this.current;
        if (now === undefined) {
            return;
        }
        let modified: number;
        try {
            modified = statSync(now.file).mtimeMs;
        } catch {
            return; // deleted or mid-save; the next change event tries again
        }
        if (modified === now.fileModifiedMs) {
            return;
        }
        this.options.logger.log('info', 'the loaded save changed: reloading', { buildId: now.buildId });
        await this.select(now.buildId, now.file, now.targetId).catch(() => undefined);
    }

    /** The PoB copy changed: stop the worker (after anything in flight) and load the current build on a new one. */
    public async restart(): Promise<void> {
        await this.exclusive(async () => {
            const client: EngineClient | undefined = this.client;
            this.client = undefined;
            await client?.shutdown().catch(() => undefined);
        });
        const now: LoadedBuild | undefined = this.current;
        if (now !== undefined) {
            await this.select(now.buildId, now.file, now.targetId).catch(() => undefined);
        }
    }

    public async shutdown(): Promise<void> {
        const client: EngineClient | undefined = this.client;
        this.client = undefined;
        await client?.shutdown().catch(() => undefined);
    }

    private ensureClient(): EngineClient {
        if (this.client === undefined) {
            const command: EngineCommand = this.options.command();
            this.client = this.options.createClient?.(command, this.options.logger) ?? new EngineClient({ command: command, logger: this.options.logger });
        }
        return this.client;
    }

    private async load(client: EngineClient, buildId: string, file: string, targetId: string): Promise<LoadedBuild> {
        const fileModifiedMs: number = statSync(file).mtimeMs;
        const xml: string = readFileSync(file, 'utf8').replace(/^﻿/, '');
        const started: number = Date.now();
        const load: WithWarnings<LoadBuildData> = await client.loadBuild(xml, basename(file));
        let target: ResolvedTarget = load.target;
        let stats: StatBlock = load.baseline;
        let warnings = load.warnings;
        if (targetId !== 'saved') {
            const s: WithWarnings<StatsData> = await client.stats({ target: targetRequest(targetId) });
            target = s.target;
            stats = s.stats;
            warnings = [...warnings, ...s.warnings];
        }
        this.options.logger.log('info', 'build loaded', { buildId: buildId, target: targetId, ms: Date.now() - started, pobVersion: load.pobVersion, damage: stats.damage });
        return {
            buildId: buildId,
            file: file,
            targetId: targetId,
            xmlHash: createHash('sha1').update(xml).digest('hex'),
            fileModifiedMs: fileModifiedMs,
            load: load,
            target: target,
            stats: stats,
            summary: buildSummary({ buildId: buildId, load: load, targetId: targetId, target: target, stats: stats, warnings: warnings, fileModifiedMs: fileModifiedMs, art: itemArt }),
        };
    }
}
