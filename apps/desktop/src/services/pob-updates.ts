// Updating the engine's PoB copy from the app (PLAN.md, "Updating PoB in the app" and "The pob-update design").
//
// Copies live in %LOCALAPPDATA%\poe-upgrade-finder\pob\<version>\ (per user, writable: PoB writes caches into
// its own folder), with pob\current.json naming the live one and the one before it (one-click rollback). The
// app's bundled copy (engine/pob/<pinned version>) is the fallback, and wins when it is newer, so a new app
// release isn't held back by an older update.
//
// An update: read master's manifest version → resolve the tag → stage from the live copy plus the changed
// files (packages/pob-update) → verify every file and the engine's hooks → rebuild Data/QueryMods.lua with
// PoB's own code (V7: the shipped one lags its code) → smoke check on the user's build
// in a separate worker → write current.json (temp + rename) → restart the engine workers. A failed step keeps
// the live copy and says why. Never silent: the user starts it, and it says it comes from PoB's GitHub.

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PobUpdateState } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import {
    checkHooks,
    compareVersions,
    parseManifest,
    type PobSource,
    type StageEvent,
    type StageReport,
    stageUpdate,
    verifyCopy,
} from '@poe-upgrade-finder/pob-update';
import { messageOf } from '@poe-upgrade-finder/validate';

export interface CurrentPob {
    readonly version: string;
    readonly previous: string | null;
}

/** The smoke check on a staged copy: throws with a reason when it doesn't pass. */
export type PobSmokeCheck = (pobDir: string) => Promise<string>;
/** Rebuilds the staged copy's Data/QueryMods.lua (engine-client rebuildQueryMods); throws when it fails. */
export type PobRebuild = (pobDir: string) => Promise<void>;

export interface PobUpdatesOptions {
    /** %LOCALAPPDATA%\poe-upgrade-finder\pob. */
    readonly root: string;
    /** The app's bundled copy (engine/pob/<pin>), if any. */
    readonly bundledDir: string | undefined;
    /** A copy given on the command line (dev): used as is, no updates. */
    readonly fixedDir: string | undefined;
    readonly source: PobSource;
    readonly logger: Logger;
    readonly onState: (state: PobUpdateState) => void;
}

const VERSION: RegExp = /^\d+\.\d+\.\d+$/;

export function manifestVersion(dir: string): string | null {
    try {
        const match: RegExpExecArray | null = /<Version\s+number="([^"]+)"/.exec(readFileSync(join(dir, 'manifest.xml'), 'utf8'));
        return match?.[1] ?? null;
    } catch {
        return null;
    }
}

export function readCurrent(root: string): CurrentPob | undefined {
    try {
        const value: unknown = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
        if (typeof value !== 'object' || value === null) {
            return undefined;
        }
        const version: unknown = 'version' in value ? value.version : undefined;
        const previous: unknown = 'previous' in value ? value.previous : null;
        if (typeof version !== 'string' || !VERSION.test(version)) {
            return undefined;
        }
        return { version: version, previous: typeof previous === 'string' && VERSION.test(previous) ? previous : null };
    } catch {
        return undefined;
    }
}

function writeCurrent(root: string, current: CurrentPob): void {
    const temp: string = join(root, 'current.json.tmp');
    writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`);
    renameSync(temp, join(root, 'current.json'));
}

export class PobUpdates {
    private readonly options: PobUpdatesOptions;
    private latest: string | null = null;
    private phase: PobUpdateState['phase'] = 'idle';
    private step: string | null = null;
    private message: string | null = null;

    public constructor(options: PobUpdatesOptions) {
        this.options = options;
    }

    /** The folder of a version: an updated copy, else the bundled one when it is that version. */
    private dirOf(version: string): string | undefined {
        const updated: string = join(this.options.root, version);
        if (manifestVersion(updated) === version) {
            return updated;
        }
        const bundled: string | undefined = this.options.bundledDir;
        return bundled !== undefined && manifestVersion(bundled) === version ? bundled : undefined;
    }

    /** The copy the engine runs: the command-line copy, else the newer of current.json's and the bundled one. */
    public liveDir(): string | undefined {
        if (this.options.fixedDir !== undefined) {
            return this.options.fixedDir;
        }
        const current: CurrentPob | undefined = readCurrent(this.options.root);
        const updated: string | undefined = current === undefined ? undefined : this.dirOf(current.version);
        const bundled: string | undefined = this.options.bundledDir;
        const bundledVersion: string | null = bundled === undefined ? null : manifestVersion(bundled);
        if (
            updated !== undefined &&
            current !== undefined &&
            (bundledVersion === null || compareVersions(current.version, bundledVersion) > 0)
        ) {
            return updated;
        }
        return bundled;
    }

    public state(): PobUpdateState {
        const live: string | undefined = this.liveDir();
        const liveVersion: string | null = live === undefined ? null : manifestVersion(live);
        const current: CurrentPob | undefined = readCurrent(this.options.root);
        const previous: string | null =
            current !== undefined &&
            current.version === liveVersion &&
            current.previous !== null &&
            this.dirOf(current.previous) !== undefined
                ? current.previous
                : null;
        return {
            live: liveVersion,
            latest: this.latest,
            phase: this.phase,
            step: this.step,
            message: this.message,
            previous: previous,
            fixed: this.options.fixedDir !== undefined,
        };
    }

    private set(phase: PobUpdateState['phase'], step: string | null, message: string | null): PobUpdateState {
        this.phase = phase;
        this.step = step;
        this.message = message;
        const state: PobUpdateState = this.state();
        this.options.onState(state);
        return state;
    }

    public async check(): Promise<PobUpdateState> {
        if (this.phase === 'updating' || this.phase === 'checking') {
            return this.state();
        }
        this.set('checking', null, null);
        try {
            this.latest = await this.options.source.latestVersion();
            this.options.logger.log('info', 'pob latest release', { latest: this.latest, live: this.state().live });
            return this.set('idle', null, null);
        } catch (error: unknown) {
            const message: string = messageOf(error);
            this.options.logger.log('warn', 'pob update check failed', { error: message });
            return this.set('failed', null, `Couldn't reach PoB Community's GitHub: ${message}`);
        }
    }

    /**
     * Updates to the latest release. `smoke` runs the user's build on the staged copy; `swap` restarts the
     * engine workers on the new live copy.
     */
    public async update(smoke: PobSmokeCheck, swap: () => Promise<void>, rebuild: PobRebuild): Promise<PobUpdateState> {
        if (this.options.fixedDir !== undefined) {
            return this.set('failed', null, 'The PoB copy was given on the command line: no updates.');
        }
        if (this.phase === 'updating') {
            return this.state();
        }
        const liveDir: string | undefined = this.liveDir();
        const liveVersion: string | null = liveDir === undefined ? null : manifestVersion(liveDir);
        if (liveDir === undefined || liveVersion === null) {
            return this.set('failed', null, 'No PoB copy to update from.');
        }
        const log: Logger = this.options.logger;
        const staging: string = join(this.options.root, `${this.latest ?? 'next'}.staging`);
        try {
            this.set('updating', 'Checking for the latest release', null);
            this.latest = await this.options.source.latestVersion();
            const latest: string = this.latest;
            if (!VERSION.test(latest)) {
                throw new Error(`unexpected version ${latest}`);
            }
            if (compareVersions(latest, liveVersion) <= 0) {
                return this.set('idle', null, `PoB ${liveVersion} is the latest release.`);
            }
            const commit: string = await this.options.source.resolveTag(`v${latest}`);
            const stagingDir: string = join(this.options.root, `${latest}.staging`);
            log.log('info', 'pob update start', { from: liveVersion, to: latest, commit: commit });
            const report: StageReport = await stageUpdate({
                liveDir: liveDir,
                stagingDir: stagingDir,
                commit: commit,
                source: this.options.source,
                onEvent: (event: StageEvent): void => {
                    if (event.kind === 'fetch') {
                        this.set('updating', `Downloading ${event.index} of ${event.total} changed files`, null);
                    } else if (event.kind === 'manifest') {
                        this.set('updating', `Comparing files with PoB ${event.version}`, null);
                    }
                },
            });
            if (report.version !== latest) {
                throw new Error(`the v${latest} tag's manifest says ${report.version}`);
            }
            this.set('updating', 'Checking every file', null);
            const bad: readonly string[] = await verifyCopy(
                stagingDir,
                parseManifest(readFileSync(join(stagingDir, 'manifest.xml'), 'utf8')),
            );
            // (verified before the rebuild, so QueryMods.lua is still PoB's own here)
            if (bad.length > 0) {
                throw new Error(`${bad.length} files don't match the manifest (${bad.slice(0, 3).join(', ')})`);
            }
            const hooks: readonly string[] = await checkHooks(stagingDir);
            if (hooks.length > 0) {
                throw new Error(`this PoB changed what the app relies on: ${hooks.join('; ')}`);
            }
            this.set('updating', 'Rebuilding the trade mod table (about 20 s)', null);
            await rebuild(stagingDir);
            this.set('updating', 'Trying your build on it', null);
            const smokeNote: string = await smoke(stagingDir);

            const finalDir: string = join(this.options.root, latest);
            rmSync(finalDir, { recursive: true, force: true });
            renameSync(stagingDir, finalDir);
            writeCurrent(this.options.root, { version: latest, previous: liveVersion });
            this.pruneExcept([latest, liveVersion]);
            log.log('info', 'pob update done', {
                from: liveVersion,
                to: latest,
                fetched: report.fetched.length,
                kept: report.kept,
                fetchedBytes: report.fetchedBytes,
                wireBytes: report.wireBytes,
                headless: report.headless,
                smoke: smokeNote,
            });
            this.set('updating', 'Restarting the engine', null);
            try {
                await swap();
            } catch (error: unknown) {
                // The new copy is already live on disk (current.json names it): only the restart failed.
                const message: string = messageOf(error);
                log.log('warn', 'pob update installed, engine restart failed', { to: latest, error: message });
                return this.set(
                    'failed',
                    null,
                    `PoB ${latest} is installed, but the engine didn't restart: ${message}. Restart the app to use it.`,
                );
            }
            return this.set('idle', null, `Updated to PoB ${latest} (${report.fetched.length} files downloaded). ${smokeNote}`);
        } catch (error: unknown) {
            const message: string = messageOf(error);
            log.log('warn', 'pob update failed', { from: liveVersion, to: this.latest, error: message });
            rmSync(staging, { recursive: true, force: true });
            for (const name of this.list()) {
                if (name.endsWith('.staging')) {
                    rmSync(join(this.options.root, name), { recursive: true, force: true });
                }
            }
            return this.set('failed', null, `The update didn't go ahead; PoB ${liveVersion} is still in use. ${message}`);
        }
    }

    public async rollback(swap: () => Promise<void>): Promise<PobUpdateState> {
        const state: PobUpdateState = this.state();
        if (state.previous === null || state.live === null || this.phase === 'updating') {
            return this.set(this.phase === 'updating' ? 'updating' : 'idle', this.step, 'Nothing to roll back to.');
        }
        writeCurrent(this.options.root, { version: state.previous, previous: state.live });
        this.options.logger.log('info', 'pob rollback', { from: state.live, to: state.previous });
        await swap();
        return this.set('idle', null, `Back on PoB ${state.previous}.`);
    }

    private list(): readonly string[] {
        try {
            return readdirSync(this.options.root);
        } catch {
            return [];
        }
    }

    /** Keeps the live and previous copies; deletes older updated copies. */
    private pruneExcept(keep: readonly string[]): void {
        for (const name of this.list()) {
            if (VERSION.test(name) && !keep.includes(name) && existsSync(join(this.options.root, name))) {
                this.options.logger.log('info', 'pob old copy deleted', { version: name });
                rmSync(join(this.options.root, name), { recursive: true, force: true });
            }
        }
    }
}
