// settings.json and characters/<build>.json (PLAN.md, Data, settings & storage). Every read is checked with
// the same checks IPC uses; anything missing or invalid falls back to the defaults.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_BLEND, DEFAULT_FLOORS, DEFAULT_MIN_GAIN_PCT } from '@poe-upgrade-finder/core';
import { readAppSettings, readBuildSettings } from '@poe-upgrade-finder/ipc';
import type { AppSettings, BuildSettings } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { readJsonFile, writeJsonFile } from './json-file.ts';

export const DEFAULT_LEAGUE: string = 'Covens';

export const DEFAULT_APP_SETTINGS: AppSettings = { league: DEFAULT_LEAGUE, listing: 'securable', depth: 'thorough', buildsDir: null, debug: false };

export function defaultBuildSettings(): BuildSettings {
    return { floors: DEFAULT_FLOORS, blend: DEFAULT_BLEND, minGainPct: DEFAULT_MIN_GAIN_PCT, lastSlot: null, lastBudget: null, lastMinBudget: null, lastTarget: null, weightEdits: {} };
}

/**
 * A build's settings file name: readable (the save's name) and unique (a hash of its id), since two folders
 * can hold saves with the same name.
 */
export function buildSettingsFileName(buildId: string): string {
    const base: string = (buildId.split('/').pop() ?? buildId).replace(/\.xml$/i, '');
    const safe: string = base.replace(/[^A-Za-z0-9 _.-]+/g, '_').trim().slice(0, 60) || 'build';
    const hash: string = createHash('sha1').update(buildId.toLowerCase()).digest('hex').slice(0, 10);
    return `${safe}-${hash}.json`;
}

export class SettingsStore {
    private readonly dir: string;
    private readonly log: Logger;
    private app: AppSettings;

    public constructor(userData: string, log: Logger) {
        this.dir = userData;
        this.log = log;
        this.app = readJsonFile(this.appFile(), readAppSettings, () => DEFAULT_APP_SETTINGS, log);
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
        return readJsonFile(this.buildFile(buildId), readBuildSettings, defaultBuildSettings, this.log);
    }

    public saveBuildSettings(buildId: string, settings: BuildSettings): BuildSettings {
        writeJsonFile(this.buildFile(buildId), settings);
        this.log.log('info', 'build settings saved', { buildId: buildId, settings: settings });
        return settings;
    }

    private appFile(): string {
        return join(this.dir, 'settings.json');
    }

    private buildFile(buildId: string): string {
        return join(this.dir, 'characters', buildSettingsFileName(buildId));
    }
}
