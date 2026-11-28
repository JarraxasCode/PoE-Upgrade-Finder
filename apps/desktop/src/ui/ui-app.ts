// The windowed app (Phase 3): one main window, the IPC server and the services behind it.
//
// Options: --pob <PoB copy> (else POE_UF_POB_DIR), --log-debug (never --debug: Electron takes it as Node's
// old debugger switch and exits with code 9).
// --smoke <file.png> [--route <view>] [--smoke-live] is a development check: the window loads hidden, the page is
// captured to the PNG once the renderer says it is ready, and the app exits (0 ok, 1 failed). It lets the
// UI be checked without anyone clicking.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, dialog } from 'electron';
import type { BrowserWindow, Event, IpcMainInvokeEvent } from 'electron';
import { luahostCommand, pinnedPobDir, POB_DIR_ENV, rebuildQueryMods, resolveEnginePaths } from '@poe-upgrade-finder/engine-client';
import type { EngineClient, QueryModsReport } from '@poe-upgrade-finder/engine-client';
import { GitHubSource } from '@poe-upgrade-finder/pob-update';
import { readRunRequest } from '@poe-upgrade-finder/ipc';
import type {
    BuildState,
    BuildsList,
    BuildSummary,
    EquippedInfo,
    MainEvent,
    PobUpdateState,
    RateState,
    SignInState,
} from '@poe-upgrade-finder/ipc';
import { JsonlLogger } from '@poe-upgrade-finder/logging';
import type { Logger } from '@poe-upgrade-finder/logging';
import { RecordedTrade, recordedListings, V19_RATE } from '../run/replay-trade.ts';
import { TradeRecorder } from '../services/trade-recorder.ts';
import type { RecordedResponse } from '@poe-upgrade-finder/trade';
import { RunController } from '../run/run-controller.ts';
import { planGear } from '../run/shared.ts';
import { CacheDb, summaryKey } from '../services/cache-db.ts';
import { planSlotData, SlotDataService } from '../services/slot-data.ts';
import { UniqueService } from '../services/uniques.ts';
import { WeightService } from '../services/weights.ts';
import type { SlotPlan } from '@poe-upgrade-finder/vocab';
import { BuildWatcher } from '../services/build-watcher.ts';
import { EngineSession } from '../services/engine-session.ts';
import { SettingsStore } from '../services/settings-store.ts';
import { TradeServices } from '../services/trade-services.ts';
import { launchedByLauncher, localAppFolder, pobVersionOf, REMOVE_EXIT_CODE, writeRemoveMarker } from '../services/remove.ts';
import { pobSmokeCheck } from '../services/pob-smoke.ts';
import { PobUpdates } from '../services/pob-updates.ts';
import { buildFileFor, createHandlers, currentBuilds } from './handlers.ts';
import type { AppServices } from './handlers.ts';
import { sendEvent, serveIpc } from './ipc-server.ts';
import { createMainWindow, isMainWindowSender } from './main-window.ts';
import { installProcessErrorHandlers } from '../process-errors.ts';
import { describeError, messageOf } from '@poe-upgrade-finder/validate';

export interface UiArgs {
    readonly smoke: string | undefined;
    readonly route: string | undefined;
    readonly pob: string | undefined;
    /** With --smoke: also run the start-up checks (one sign-in search, the divine rate) before capturing. */
    readonly smokeLive: boolean;
    /** Development: a recorded trade file to replay instead of the trade site (no sign-in, no trade calls). */
    readonly replay: string | undefined;
    /** Development: save every trade search and fetch response of live runs to this file (a fixture's raw input). */
    readonly recordTrade: string | undefined;
    /** With --smoke and --replay: "buildId|slot|budget|depth" starts a run; captures <file>-live.png mid-run, then <file> when done. */
    readonly smokeRun: string | undefined;
    /** With --smoke: a script run in the page just before the final capture (to open a group or a detail). */
    readonly smokeJs: string | undefined;
    /** With --smoke under the launcher: after the capture, do what the remove dialog's Remove does (no dialog). */
    readonly smokeRemove: boolean;
    readonly debug: boolean;
}

export function parseUiArgs(argv: readonly string[]): UiArgs {
    const valueOf = (flag: string): string | undefined => {
        const i: number = argv.indexOf(flag);
        return i < 0 ? undefined : argv[i + 1];
    };
    return {
        smoke: valueOf('--smoke'),
        route: valueOf('--route'),
        pob: valueOf('--pob'),
        smokeLive: argv.includes('--smoke-live'),
        replay: valueOf('--replay'),
        recordTrade: valueOf('--record-trade'),
        smokeRun: valueOf('--smoke-run'),
        smokeJs: valueOf('--smoke-js'),
        smokeRemove: argv.includes('--smoke-remove'),
        debug: argv.includes('--log-debug'),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise<void>((done: () => void) => {
        setTimeout(done, ms);
    });
}

async function capture(win: BrowserWindow, file: string, log: Logger): Promise<void> {
    // Let the renderer paint the latest state first: capturePage can return the previous frame of a hidden window.
    await win.webContents.executeJavaScript(
        'new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 500); })',
    );
    win.webContents.invalidate();
    await sleep(300);
    const image = await win.webContents.capturePage();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, image.toPNG());
    log.log('info', 'smoke capture written', { file: file });
    process.stdout.write(`smoke: wrote ${file}\n`);
}

/**
 * Starts a replayed run, captures the Run view mid-run and when done. The spec is
 * "<build id>|<slot>|<budget>|<depth>[|<slot plan .json>]"; without a plan file the slot searches as v0.1 did.
 */
async function smokeRunCapture(win: BrowserWindow, file: string, spec: string, runs: RunController, log: Logger): Promise<void> {
    const [buildId, slot, budget, depth, planFile] = spec.split('|');
    const plan: unknown =
        planFile === undefined || planFile === ''
            ? { slot: slot, itemType: null, base: null, picks: [] }
            : JSON.parse(readFileSync(planFile, 'utf8'));
    const request = readRunRequest(
        {
            buildId: buildId,
            slots: [plan],
            budget: budget,
            minBudget: '',
            target: 'saved',
            depth: depth ?? 'quick',
            listing: 'securable',
        },
        'smoke-run',
    );
    await runs.start(request);
    await win.webContents.executeJavaScript('location.hash = "#/run"');
    await sleep(2500);
    await capture(win, file.replace(/\.png$/i, '-live.png'), log);
    for (let i: number = 0; i < 600 && runs.busy; i++) {
        await sleep(200);
    }
    // Then until the page shows the finished run (the summary event can land after the run reads idle).
    for (let i: number = 0; i < 50; i++) {
        const done: unknown = await win.webContents.executeJavaScript(
            '!/^(Searching|Paused)/.test(document.querySelector("h1")?.textContent ?? "")',
        );
        if (done === true) {
            break;
        }
        await sleep(200);
    }
    await sleep(500);
}

async function smokeCapture(
    win: BrowserWindow,
    file: string,
    route: string | undefined,
    log: Logger,
    problems: readonly string[],
    run?: { readonly spec: string; readonly runs: RunController },
    script?: string,
): Promise<number> {
    const contents = win.webContents;
    if (contents.isLoading()) {
        await new Promise<void>((done: () => void) => {
            contents.once('did-finish-load', () => {
                done();
            });
        });
    }
    if (route !== undefined) {
        await contents.executeJavaScript(`location.hash = ${JSON.stringify(`#/${route}`)}`);
    }
    for (let i: number = 0; i < 50; i++) {
        const ready: unknown = await contents.executeJavaScript('document.documentElement.dataset.ready === "1"');
        if (ready === true) {
            break;
        }
        await sleep(100);
    }
    await sleep(300);
    if (run !== undefined) {
        await smokeRunCapture(win, file, run.spec, run.runs, log);
    }
    if (script !== undefined) {
        await contents.executeJavaScript(script);
        await sleep(400);
    }
    await capture(win, file, log);
    for (const p of problems) {
        process.stdout.write(`smoke: problem: ${p}\n`);
    }
    return problems.length === 0 ? 0 : 1;
}

export async function runUiApp(argv: readonly string[], userData: string, appVersion: string): Promise<number | undefined> {
    const args: UiArgs = parseUiArgs(argv);
    if (args.smoke === undefined && !app.requestSingleInstanceLock()) {
        process.stdout.write('PoE Upgrade Finder is already running.\n');
        return 0;
    }
    const store: SettingsStore = new SettingsStore(
        userData,
        new JsonlLogger({ dir: join(userData, 'logs'), debug: false }).area('settings'),
    );
    const logger: JsonlLogger = new JsonlLogger({ dir: join(userData, 'logs'), debug: args.debug || store.settings.debug });
    const uiLog: Logger = logger.area('ui');
    uiLog.log('info', 'app starting', { appVersion: appVersion, electron: process.versions.electron, smoke: args.smoke !== undefined });
    installProcessErrorHandlers(process, {
        log: logger.area('main'),
        onFatal: (error: Error) => {
            if (args.smoke === undefined) {
                dialog.showErrorBox(
                    'PoE Upgrade Finder hit an error and will close',
                    `${messageOf(error)}

The details are in the app's log: after restarting, use Export logs on the Settings view to save them.`,
                );
            } else {
                process.stderr.write(`smoke: uncaught exception in the main process: ${messageOf(error)}
`);
            }
            app.exit(1);
        },
    });

    let win: BrowserWindow | undefined;
    const emit = (event: MainEvent): void => {
        sendEvent(win?.webContents, event);
    };
    const problems: string[] = [];
    const onProblem = (message: string): void => {
        problems.push(message);
    };

    const fixedPob: string | undefined = args.pob ?? (process.env[POB_DIR_ENV] === '' ? undefined : process.env[POB_DIR_ENV]);
    const pob: PobUpdates = new PobUpdates({
        root: join(localAppFolder() ?? join(userData, 'local'), 'pob'),
        bundledDir: pinnedPobDir(),
        fixedDir: fixedPob,
        source: new GitHubSource({ userAgent: `poe-upgrade-finder/${appVersion}` }),
        logger: logger.area('pob-update'),
        onState: (state: PobUpdateState) => {
            emit({ kind: 'pob-state', state: state });
        },
    });
    const session: EngineSession = new EngineSession({
        command: () => luahostCommand(resolveEnginePaths(pob.liveDir())),
        logger: logger.area('engine'),
        onState: (state: BuildState) => {
            emit({ kind: 'build-state', state: state });
        },
        // The cache is opened just below; these only run once a build loads.
        gearCache: {
            get: (id: string) => cache.equipped(id),
            save: (id: string, items: readonly EquippedInfo[]) => {
                cache.saveEquipped(id, items);
            },
        },
        summaryCache: {
            get: (xmlHash: string, targetId: string, pobVersion: string) =>
                cache.buildSummary(summaryKey({ xmlHash: xmlHash, targetId: targetId, pobVersion: pobVersion, appVersion: appVersion })),
            save: (xmlHash: string, targetId: string, pobVersion: string, summary: BuildSummary) => {
                cache.saveBuildSummary(
                    summaryKey({ xmlHash: xmlHash, targetId: targetId, pobVersion: pobVersion, appVersion: appVersion }),
                    summary,
                );
            },
        },
        pobVersion: () => pobVersionOf(pob.liveDir()),
    });
    const cache: CacheDb = new CacheDb(join(userData, 'cache.sqlite'));
    const recorder: TradeRecorder | undefined =
        args.recordTrade === undefined ? undefined : new TradeRecorder(args.recordTrade, logger.area('trade'));
    if (args.recordTrade !== undefined) {
        logger.area('trade').log('warn', 'record-trade: saving every trade search and fetch response', { file: args.recordTrade });
    }
    const trade: TradeServices = new TradeServices({
        ...(recorder === undefined ? {} : { onResponse: (r: RecordedResponse): void => recorder.record(r) }),
        userData: userData,
        rateStore: cache.rateStore(),
        statCache: cache,
        appVersion: appVersion,
        logger: logger,
        league: () => store.settings.league,
        onSignIn: (state: SignInState) => {
            emit({ kind: 'signin-state', state: state });
        },
        onRate: (state: RateState) => {
            emit({ kind: 'rate-state', state: state });
        },
    });
    const slotData: SlotDataService = new SlotDataService({
        cache: cache,
        pobVersion: () => pobVersionOf(pob.liveDir()),
        fetch: (itemType: string) => session.exclusive((client: EngineClient) => client.slotData(itemType)),
        logger: logger.area('engine'),
    });
    const weights: WeightService = new WeightService({
        cache: cache,
        session: session,
        buildFile: (buildId: string) => buildFileFor(services, buildId),
        blend: (buildId: string) => store.buildSettings(buildId).blend,
        // Never fetched in replay mode (the cached list only).
        catalog: () => trade.catalog(args.replay !== undefined),
        slotData: (plan: SlotPlan) => planSlotData(slotData, plan),
        // The loaded build's weapons, else the ones PoB reported last time (the gear cache).
        gear: (buildId: string) => {
            const loaded = session.loaded;
            if (loaded !== undefined && loaded.buildId === buildId) {
                return planGear(loaded.load.equipped);
            }
            const cached = cache.equipped(buildId);
            return cached === undefined ? undefined : planGear(cached.map((e) => ({ slot: e.slot, type: e.itemType ?? undefined })));
        },
        logger: logger.area('run'),
    });
    const uniques: UniqueService = new UniqueService({
        cache: cache,
        session: session,
        buildFile: (buildId: string) => buildFileFor(services, buildId),
        blend: (buildId: string) => store.buildSettings(buildId).blend,
        catalog: () => trade.catalog(args.replay !== undefined),
        logger: logger.area('run'),
    });
    const services: AppServices = {
        appVersion: appVersion,
        pob: pob,
        pobSmoke: (dir: string) => {
            const loaded = session.loaded;
            return pobSmokeCheck(
                dir,
                loaded === undefined ? undefined : { file: loaded.file, baseline: loaded.load.baseline },
                logger.area('pob-update'),
            );
        },
        pobSwap: () => session.restart(),
        pobRebuild: async (dir: string) => {
            const report: QueryModsReport = await rebuildQueryMods(resolveEnginePaths(dir));
            logger.area('pob-update').log('info', 'QueryMods.lua rebuilt', { ...report });
        },
        userData: userData,
        exitForRemoval: () => {
            uiLog.log('info', 'remove from this PC: exiting for the launcher', { code: REMOVE_EXIT_CODE });
            quitting = true;
            watcher.stop();
            void session.shutdown().finally(() => {
                app.exit(REMOVE_EXIT_CODE);
            });
        },
        documentsDir: app.getPath('documents'),
        logsDir: join(userData, 'logs'),
        downloadsDir: app.getPath('downloads'),
        store: store,
        session: session,
        trade: trade,
        slotData: slotData,
        weights: weights,
        uniques: uniques,
        runs: () => runs,
        window: () => win,
        onBuildsDirChanged: (list: BuildsList) => {
            watcher.watch(list.dir);
            emit({ kind: 'builds-changed', list: list });
        },
        onLeagueChanged: () => {
            void trade.check();
            void trade.getRate();
        },
    };
    const runs: RunController = new RunController({
        userData: userData,
        appVersion: appVersion,
        logger: logger,
        store: store,
        session: session,
        trade: trade,
        buildFile: (buildId: string) => buildFileFor(services, buildId),
        emit: emit,
        weights: weights,
        uniques: uniques,
        slotData: slotData,
        ...(args.replay === undefined
            ? {}
            : { replay: { trade: new RecordedTrade(recordedListings(args.replay), 120), chaosPerDivine: V19_RATE } }),
    });
    if (args.replay !== undefined) {
        uiLog.log('warn', 'replay mode: recorded listings, no trade calls', { file: args.replay });
    }
    const watcher: BuildWatcher = new BuildWatcher(() => {
        emit({ kind: 'builds-changed', list: currentBuilds(services) });
        void session.reloadIfChanged();
    }, logger.area('builds'));
    watcher.watch(currentBuilds(services).dir);

    serveIpc(createHandlers(services), (event: IpcMainInvokeEvent) => isMainWindowSender(win, event), logger.area('ipc'), onProblem);

    win = createMainWindow({ logger: uiLog, hidden: args.smoke !== undefined, onProblem: onProblem });
    // Settings repairs (issue #69) show once the page can receive them; the app settings were read before it existed.
    win.webContents.once('did-finish-load', () => {
        store.setNotifier((message: string) => {
            emit({ kind: 'notice', level: 'warn', message: message });
        });
    });
    let quitting: boolean = false;
    app.on('before-quit', (event: Event) => {
        if (quitting) {
            return;
        }
        quitting = true;
        event.preventDefault();
        watcher.stop();
        void session.shutdown().finally(() => {
            app.quit();
        });
    });
    app.on('second-instance', () => {
        if (win !== undefined && !win.isDestroyed()) {
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();
        }
    });
    if (args.smoke === undefined || args.smokeLive) {
        // Once per start: one search through the shared limiter, the divine rate (GGG's CDN, not trade) and
        // PoB's latest release (master's manifest.xml on PoB Community's GitHub, about 170 KB).
        // A plain smoke check makes no network calls.
        const checks: Promise<unknown> = Promise.allSettled([trade.check(), trade.getRate(), pob.check()]);
        if (args.smoke !== undefined) {
            await checks;
        }
    }
    if (args.smoke !== undefined) {
        if (args.smokeRemove) {
            const local: string | undefined = localAppFolder();
            if (!launchedByLauncher() || local === undefined) {
                process.stderr.write('smoke failed: --smoke-remove needs the launcher\n');
                return 1;
            }
            await smokeCapture(win, args.smoke, args.route, uiLog, problems, undefined, undefined);
            writeRemoveMarker(local);
            services.exitForRemoval();
            return undefined;
        }
        try {
            return await smokeCapture(
                win,
                args.smoke,
                args.route,
                uiLog,
                problems,
                args.smokeRun === undefined || args.replay === undefined ? undefined : { spec: args.smokeRun, runs: runs },
                args.smokeJs,
            );
        } catch (error: unknown) {
            process.stderr.write(`smoke failed: ${describeError(error)}\n`);
            return 1;
        } finally {
            watcher.stop();
            await session.shutdown();
        }
    }
    app.on('window-all-closed', () => {
        uiLog.log('info', 'main window closed: quitting');
        app.quit();
    });
    return undefined;
}
