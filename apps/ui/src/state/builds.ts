// The PoB saves, the one chosen on the Search view, its per-build settings, and what PoB loaded.
// Main pushes builds-changed and build-state events (a re-saved build reloads by itself).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { BuildSettings, BuildState, BuildsList, GearSlot } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import type { Loadable } from './loadable.ts';
import { readyValue } from './loadable.ts';
import { messageOf } from '@poe-upgrade-finder/validate';

export const buildsList: Signal<Loadable<BuildsList>> = signal<Loadable<BuildsList>>({ kind: 'loading' });
export const selectedBuildId: Signal<string | null> = signal<string | null>(null);
export const buildSettings: Signal<Loadable<BuildSettings>> = signal<Loadable<BuildSettings>>({ kind: 'loading' });
export const buildState: Signal<BuildState> = signal<BuildState>({ kind: 'none' });

const LAST_BUILD_KEY: string = 'uf.lastBuild';

/** The last build chosen in this window (a per-viewer convenience: browser storage, may be empty). */
function rememberedBuild(): string | null {
    try {
        return window.localStorage.getItem(LAST_BUILD_KEY);
    } catch {
        return null;
    }
}

function remember(id: string): void {
    try {
        window.localStorage.setItem(LAST_BUILD_KEY, id);
    } catch {
        // storage blocked: nothing to remember
    }
}

export function setBuildsList(list: BuildsList): void {
    buildsList.value = { kind: 'ready', value: list };
    const id: string | null = selectedBuildId.value;
    if (id !== null && !list.builds.some((b) => b.id === id)) {
        selectedBuildId.value = null;
        buildState.value = { kind: 'none' };
    }
}

export async function loadBuilds(): Promise<void> {
    try {
        setBuildsList(await call('builds.list', {}));
    } catch (error: unknown) {
        buildsList.value = { kind: 'error', message: messageOf(error) };
        return;
    }
    const list: BuildsList | undefined = readyValue(buildsList.value);
    const last: string | null = rememberedBuild();
    if (selectedBuildId.value === null && list !== undefined) {
        const pick: string | undefined = list.builds.find((b) => b.id === last)?.id ?? list.builds[0]?.id;
        if (pick !== undefined) {
            await selectBuild(pick);
        }
    }
}

/** Chooses a build: its settings, then PoB loads it with its last damage target. */
export async function selectBuild(id: string): Promise<void> {
    selectedBuildId.value = id;
    remember(id);
    buildSettings.value = { kind: 'loading' };
    let settings: BuildSettings;
    try {
        settings = await call('build.settings.get', { buildId: id });
    } catch (error: unknown) {
        buildSettings.value = { kind: 'error', message: messageOf(error) };
        return;
    }
    if (selectedBuildId.value !== id) {
        return;
    }
    buildSettings.value = { kind: 'ready', value: settings };
    await loadInPob(id, settings.lastTarget);
}

async function loadInPob(id: string, target: string | null): Promise<void> {
    try {
        await call('build.select', { buildId: id, target: target });
    } catch (error: unknown) {
        // PoB's own errors also arrive as a build-state event (shown under the form); this is for the log.
        console.warn('build.select failed', messageOf(error));
    }
}

/**
 * Saves the selected build's settings with a change. Throws when saving fails (Settings shows it); the
 * Search view's small remembers (slot, budget, target) go through rememberForBuild instead.
 */
export async function updateBuildSettings(change: Partial<BuildSettings>): Promise<void> {
    const id: string | null = selectedBuildId.value;
    const now: BuildSettings | undefined = readyValue(buildSettings.value);
    if (id === null || now === undefined) {
        return;
    }
    const next: BuildSettings = { ...now, ...change };
    buildSettings.value = { kind: 'ready', value: next };
    try {
        const saved: BuildSettings = await call('build.settings.save', { buildId: id, settings: next });
        if (selectedBuildId.value === id) {
            buildSettings.value = { kind: 'ready', value: saved };
        }
    } catch (error: unknown) {
        if (selectedBuildId.value === id) {
            buildSettings.value = { kind: 'ready', value: now };
        }
        throw error;
    }
}

/** The Search view's choices, remembered per build. Losing one isn't worth an error on screen: logged only. */
export function rememberForBuild(change: Partial<BuildSettings>): Promise<void> {
    return updateBuildSettings(change).catch((error: unknown) => {
        console.warn('could not remember a search choice', error);
    });
}

export async function setTarget(target: string): Promise<void> {
    const id: string | null = selectedBuildId.value;
    if (id === null) {
        return;
    }
    await rememberForBuild({ lastTarget: target });
    await loadInPob(id, target);
}

export function setSlot(slot: GearSlot): void {
    void rememberForBuild({ lastSlot: slot });
}
