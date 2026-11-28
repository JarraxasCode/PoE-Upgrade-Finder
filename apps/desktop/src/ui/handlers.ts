// The IPC handlers: each method of the contract, over the app's services. Kept apart from the window and
// lifecycle code (ui-app.ts) so the list of what the renderer can ask for is in one place.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dialog, shell } from 'electron';
import type { BrowserWindow, OpenDialogReturnValue, SaveDialogReturnValue } from 'electron';
import type {
    AppInfo,
    AppSettings,
    PobUpdateState,
    BuildSettings,
    BuildsList,
    BuildSummary,
    LimitPanel,
    UniqueList,
    WeightPreview,
    LogsView,
    RateState,
    RunHeader,
    RunPhase,
    RunRequest,
    RunSnapshot,
    SignInState,
    SlotEditorData,
} from '@poe-upgrade-finder/ipc';
import { UserFacingError } from './ipc-server.ts';
import type { Handlers } from './ipc-server.ts';
import type { RunController } from '../run/run-controller.ts';
import type { EngineSession } from '../services/engine-session.ts';
import { exportZip, recentLogs } from '../services/logs.ts';
import type { LogQuery } from '../services/logs.ts';
import { buildFilePath, listBuilds, resolveBuildsDir } from '../services/pob-builds.ts';
import type { PobRebuild, PobSmokeCheck, PobUpdates } from '../services/pob-updates.ts';
import { launchedByLauncher, localAppFolder, pobLicenseOf, pobVersionOf, writeRemoveMarker } from '../services/remove.ts';
import { dayStamp } from '@poe-upgrade-finder/logging';
import type { SettingsStore } from '../services/settings-store.ts';
import type { SlotDataService } from '../services/slot-data.ts';
import type { UniqueService } from '../services/uniques.ts';
import type { WeightService } from '../services/weights.ts';
import type { TradeServices } from '../services/trade-services.ts';
import type { GearSlot, SlotPlan } from '@poe-upgrade-finder/vocab';

export interface AppServices {
    readonly appVersion: string;
    /** Updating the engine's PoB copy; its liveDir() is the copy the engine runs. */
    readonly pob: PobUpdates;
    /** The staged copy's smoke check on the loaded build. */
    readonly pobSmoke: PobSmokeCheck;
    /** Rebuilds a staged copy's QueryMods.lua. */
    readonly pobRebuild: PobRebuild;
    /** Restarts the engine workers on the (new) live copy. */
    readonly pobSwap: () => Promise<void>;
    /** Stops the engine and exits with the remove code (the launcher then deletes the folders). */
    readonly exitForRemoval: () => void;
    readonly documentsDir: string;
    /** The app's logs folder (app data's logs/). */
    readonly logsDir: string;
    /** The app data folder (Roaming), shown in the remove dialog. */
    readonly userData: string;
    /** Where Export logs suggests saving. */
    readonly downloadsDir: string;
    readonly store: SettingsStore;
    readonly session: EngineSession;
    readonly trade: TradeServices;
    /** PoB's mods per item type (cached), for the slot plan editor and runs. */
    readonly slotData: SlotDataService;
    /** The weights and the weight review (PoB's generator, cached). */
    readonly weights: WeightService;
    /** The uniques for a slot's item type, for the unique picker (#113). */
    readonly uniques: UniqueService;
    readonly runs: () => RunController;
    readonly window: () => BrowserWindow | undefined;
    /** The Builds folder setting changed: watch the new folder and tell the renderer. */
    readonly onBuildsDirChanged: (list: BuildsList) => void;
    /** The league changed: sign-in and the divine rate depend on it. */
    readonly onLeagueChanged: () => void;
}

export function currentBuilds(services: AppServices): BuildsList {
    return listBuilds(resolveBuildsDir(services.documentsDir, services.store.settings.buildsDir));
}

/** A build id's save, only when it is in the Builds folder now. */
export function buildFileFor(services: AppServices, buildId: string): string | undefined {
    const list: BuildsList = currentBuilds(services);
    const file: string | undefined = list.dir === null ? undefined : buildFilePath(list.dir, buildId);
    return file !== undefined && list.builds.some((b) => b.id === buildId) ? file : undefined;
}

export function createHandlers(services: AppServices): Handlers {
    const { store, session, trade } = services;
    return {
        'app.info': (): Promise<AppInfo> =>
            Promise.resolve({
                appVersion: services.appVersion,
                electron: process.versions.electron,
                chromium: process.versions.chrome,
                node: process.versions.node,
                pobVersion: pobVersionOf(services.pob.liveDir()),
                canRemove: launchedByLauncher(),
            }),

        'pob.status': (): Promise<PobUpdateState> => Promise.resolve(services.pob.state()),
        'pob.check': (): Promise<PobUpdateState> => services.pob.check(),
        'pob.update': (): Promise<PobUpdateState> => {
            if (services.runs().busy) {
                throw new UserFacingError('Finish or cancel the run first: the engine restarts after an update.');
            }
            return services.pob.update(services.pobSmoke, services.pobSwap, services.pobRebuild);
        },
        'pob.rollback': (): Promise<PobUpdateState> => {
            if (services.runs().busy) {
                throw new UserFacingError('Finish or cancel the run first: the engine restarts after a rollback.');
            }
            return services.pob.rollback(services.pobSwap);
        },

        'app.pobLicense': (): Promise<{ readonly text: string | null }> => Promise.resolve({ text: pobLicenseOf(services.pob.liveDir()) }),

        'app.removeFromPc': async (): Promise<{ readonly removing: boolean; readonly message: string | null }> => {
            const local: string | undefined = localAppFolder();
            if (!launchedByLauncher() || local === undefined) {
                return { removing: false, message: 'Only the app started from its exe can remove itself.' };
            }
            const win: BrowserWindow | undefined = services.window();
            const options = {
                type: 'warning' as const,
                title: 'Remove from this PC',
                message: 'Remove PoE Upgrade Finder from this PC?',
                detail:
                    `This deletes the app's files (${local}) and its settings, logs, saved runs and pathofexile.com sign-in (${services.userData}).

` + 'Your Path of Building builds are not touched. The app closes, and then you can delete the exe.',
                buttons: ['Remove', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            };
            const answer = win === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(win, options);
            if (answer.response !== 0) {
                return { removing: false, message: null };
            }
            writeRemoveMarker(local);
            // After the reply has gone back to the renderer.
            setTimeout(() => {
                services.exitForRemoval();
            }, 50);
            return { removing: true, message: null };
        },

        'settings.get': (): Promise<AppSettings> => Promise.resolve(store.settings),

        'settings.save': (params: { readonly settings: AppSettings }): Promise<AppSettings> => {
            const before: AppSettings = store.settings;
            const saved: AppSettings = store.saveSettings(params.settings);
            if (saved.buildsDir !== before.buildsDir) {
                services.onBuildsDirChanged(currentBuilds(services));
            }
            if (saved.league !== before.league) {
                services.onLeagueChanged();
            }
            return Promise.resolve(saved);
        },

        'settings.pickBuildsDir': async (): Promise<string | null> => {
            const win: BrowserWindow | undefined = services.window();
            const options = { title: 'Choose the PoB Builds folder', properties: ['openDirectory' as const] };
            const picked: OpenDialogReturnValue =
                win === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
            return picked.canceled ? null : (picked.filePaths[0] ?? null);
        },

        'builds.list': (): Promise<BuildsList> => Promise.resolve(currentBuilds(services)),

        'build.select': (params: { readonly buildId: string; readonly target: string | null }): Promise<BuildSummary> => {
            if (services.runs().busy) {
                return Promise.reject(
                    new UserFacingError('A run is going: PoB loads another build or target once it ends (or cancel it).'),
                );
            }
            const file: string | undefined = buildFileFor(services, params.buildId);
            if (file === undefined) {
                return Promise.reject(new UserFacingError(`That build isn't in the Builds folder any more: ${params.buildId}`));
            }
            return session.select(params.buildId, file, params.target ?? 'saved');
        },

        'build.settings.get': (params: { readonly buildId: string }): Promise<BuildSettings> =>
            Promise.resolve(store.buildSettings(params.buildId)),

        'build.settings.save': (params: { readonly buildId: string; readonly settings: BuildSettings }): Promise<BuildSettings> =>
            Promise.resolve(store.saveBuildSettings(params.buildId, params.settings)),

        'weights.preview': (params: {
            readonly buildId: string;
            readonly slot: GearSlot;
            readonly target: string;
            readonly plan: SlotPlan | null;
        }): Promise<WeightPreview> => services.weights.preview(params.buildId, params.slot, params.target, params.plan),
        'uniques.list': (params: {
            readonly buildId: string;
            readonly slot: GearSlot;
            readonly target: string;
            readonly itemType: string;
        }): Promise<UniqueList> => services.uniques.list(params.buildId, params.slot, params.target, params.itemType),

        'slot.data': async (params: {
            readonly slot: GearSlot;
            readonly itemType: string;
            readonly base: string | null;
        }): Promise<SlotEditorData> => {
            // The site's pseudo stats for the Totals list (issue #26); the cached stat list, fetched once a week.
            const catalog = await trade.catalog();
            return services.slotData.editorData(params.slot, params.itemType, params.base, catalog?.pseudoStats() ?? [], (id: string) =>
                catalog?.rank(id),
            );
        },

        'signin.status': (): Promise<SignInState> => Promise.resolve(trade.signInState),
        'signin.check': (): Promise<SignInState> => trade.check(),
        'signin.open': (): Promise<SignInState> => trade.openSignIn(),
        'signin.signOut': (): Promise<SignInState> => trade.signOut(),

        'rate.status': (): Promise<RateState> => Promise.resolve(trade.rateState),
        'rate.get': (): Promise<RateState> => trade.getRate(),
        'rate.refresh': (): Promise<RateState> => trade.refreshRate(),
        'rate.setManual': (params: { readonly chaosPerDivine: number }): Promise<RateState> =>
            Promise.resolve(trade.setManualRate(params.chaosPerDivine)),
        'rate.useGgg': (): Promise<RateState> => trade.useGgg(),

        'run.start': (params: { readonly request: RunRequest }): Promise<RunHeader> => services.runs().start(params.request),
        'run.pause': (): Promise<RunPhase> => Promise.resolve(services.runs().pause()),
        'run.resume': (): Promise<RunPhase> => Promise.resolve(services.runs().resume()),
        'run.cancel': (): Promise<RunPhase> => Promise.resolve(services.runs().cancel()),
        'run.deepen': (params: { readonly runId: string }): Promise<RunHeader> => services.runs().deepen(params.runId),
        'run.current': (): Promise<RunSnapshot | null> => Promise.resolve(services.runs().snapshot()),
        'run.limits': (): Promise<LimitPanel> => Promise.resolve(services.runs().limits()),
        'logs.recent': (params: LogQuery): Promise<LogsView> => Promise.resolve(recentLogs(services.logsDir, params)),

        'logs.export': async (params: {
            readonly runId: string | null;
        }): Promise<{ readonly saved: boolean; readonly file: string | null }> => {
            const win: BrowserWindow | undefined = services.window();
            const options = {
                title: 'Export logs',
                defaultPath: join(services.downloadsDir, `poe-upgrade-finder-logs-${dayStamp(Date.now())}.zip`),
                filters: [{ name: 'Zip', extensions: ['zip'] }],
            };
            const picked: SaveDialogReturnValue =
                win === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(win, options);
            if (picked.canceled || picked.filePath === undefined || picked.filePath === '') {
                return { saved: false, file: null };
            }
            writeFileSync(
                picked.filePath,
                exportZip(services.logsDir, params.runId, { appVersion: services.appVersion, electron: process.versions.electron }),
            );
            shell.showItemInFolder(picked.filePath);
            return { saved: true, file: picked.filePath };
        },

        'link.open': (params: {
            readonly runId: string;
            readonly itemId: string;
        }): Promise<{ readonly opened: boolean; readonly message: string | null }> => services.runs().openLink(params.runId, params.itemId),
    };
}
