// settings.json and characters/<build>.json (PLAN.md, Data, settings & storage). Every read is checked with
// the same checks IPC uses. A build file is read field by field, so a bad part falls back alone; a bad file is
// kept as a .bad copy and the user gets a notice (issue #69).

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_BLEND, DEFAULT_FLOORS, DEFAULT_LEVEL_FILTER, DEFAULT_MIN_GAIN_PCT } from '@poe-upgrade-finder/core';
import { readAppSettings, readStoredBuildSettings } from '@poe-upgrade-finder/ipc';
import type { AppSettings, BuildSettings } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { readJsonFile, writeJsonFile } from './json-file.ts';
import type { JsonFileRepair } from './json-file.ts';

export const DEFAULT_LEAGUE: string = 'Covens';

export const DEFAULT_APP_SETTINGS: AppSettings = {
    league: DEFAULT_LEAGUE,
    listing: 'securable',
    depth: 'normal',
    buildsDir: null,
    debug: false,
};

export function defaultBuildSettings(): BuildSettings {
    return {
        floors: DEFAULT_FLOORS,
        blend: DEFAULT_BLEND,
        minGainPct: DEFAULT_MIN_GAIN_PCT,
        lastSlot: null,
        lastBudget: null,
        lastMinBudget: null,
        lastTarget: null,
        slotPlans: {},
        weightEdits: {},
        levelFilter: DEFAULT_LEVEL_FILTER,
        uniqueChoices: {},
    };
}

/**
 * A build's settings file name: readable (the save's name) and unique (a hash of its id), since two folders
 * can hold saves with the same name.
 */
export function buildSettingsFileName(buildId: string): string {
    const base: string = (buildId.split('/').pop() ?? buildId).replace(/\.xml$/i, '');
    const safe: string =
        base
            .replace(/[^A-Za-z0-9 _.-]+/g, '_')
            .trim()
            .slice(0, 60) || 'build';
    const hash: string = createHash('sha1').update(buildId.toLowerCase()).digest('hex').slice(0, 10);
    return `${safe}-${hash}.json`;
}

export class SettingsStore {
    private readonly dir: string;
    private readonly log: Logger;
    private app: AppSettings;
    /** Repair notices waiting for `setNotifier` (the app settings are read before the window exists). */
    private readonly pending: string[] = [];
    private notifier: ((message: string) => void) | undefined;

    public constructor(userData: string, log: Logger) {
        this.dir = userData;
        this.log = log;
        this.app = readJsonFile(this.appFile(), {
            read: readAppSettings,
            fallback: () => DEFAULT_APP_SETTINGS,
            log: log,
            onRepair: (repair: JsonFileRepair) => {
                this.notify(`The app settings file was invalid, so the defaults are back. The old file is kept as ${repair.backup}.`);
            },
        });
    }

    /** Where repair notices go from now on; any waiting ones are sent at once. */
    public setNotifier(notifier: (message: string) => void): void {
        this.notifier = notifier;
        for (const message of this.pending.splice(0)) {
            notifier(message);
        }
    }

    public get settings(): AppSettings {
        return this.app;
    }

    public saveSettings(settings: AppSettings): AppSettings {
        writeJsonFile(this.appFile(), settings);
        this.app = settings;
        this.log.log('info', 'settings saved', { ...settings });
        return settings;
    }

    public buildSettings(buildId: string): BuildSettings {
        return readJsonFile(this.buildFile(buildId), {
            read: (value: unknown, path: string, dropped: (problem: string) => void) =>
                readStoredBuildSettings(value, path, defaultBuildSettings(), dropped),
            fallback: defaultBuildSettings,
            log: this.log,
            onRepair: (repair: JsonFileRepair) => {
                const name: string = buildId.split('/').pop() ?? buildId;
                const what: string = repair.problems.length === 1 ? 'one setting' : `${repair.problems.length} settings`;
                this.notify(
                    `Some saved settings for ${name} were invalid (${what}) and went back to their defaults; the rest were kept. ` +
                        `The old file is kept as ${repair.backup}.`,
                );
            },
        });
    }

    public saveBuildSettings(buildId: string, settings: BuildSettings): BuildSettings {
        writeJsonFile(this.buildFile(buildId), settings);
        this.log.log('info', 'build settings saved', { buildId: buildId, settings: settings });
        return settings;
    }

    private notify(message: string): void {
        if (this.notifier === undefined) {
            this.pending.push(message);
        } else {
            this.notifier(message);
        }
    }

    private appFile(): string {
        return join(this.dir, 'settings.json');
    }

    private buildFile(buildId: string): string {
        return join(this.dir, 'characters', buildSettingsFileName(buildId));
    }
}
