// The PoB saves, the one chosen on the Search view, its per-build settings, and what PoB loaded.
// Main pushes builds-changed and build-state events (a re-saved build reloads by itself).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { BuildSettings, BuildState, BuildSummary, BuildsList } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import type { Loadable } from './loadable.ts';
import { readyValue } from './loadable.ts';
import { messageOf } from '@poe-upgrade-finder/validate';
import type { GearSlot } from '@poe-upgrade-finder/vocab';
import { dismissKey, notify } from './notices.ts';

export const buildsList: Signal<Loadable<BuildsList>> = signal<Loadable<BuildsList>>({ kind: 'loading' });
export const selectedBuildId: Signal<string | null> = signal<string | null>(null);
export const buildSettings: Signal<Loadable<BuildSettings>> = signal<Loadable<BuildSettings>>({ kind: 'loading' });
export const buildState: Signal<BuildState> = signal<BuildState>({ kind: 'none' });

/** A build's settings that failed to save (plan, weight or filter edits): kept on screen until a save works. */
export interface UnsavedSettings {
    readonly buildId: string;
    readonly settings: BuildSettings;
}

export const unsaved: Signal<UnsavedSettings | null> = signal<UnsavedSettings | null>(null);

const UNSAVED_KEY: string = 'unsaved-settings';

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
    // Edits that didn't save stay on screen (and in the next save) rather than vanish on a build switch.
    const kept: UnsavedSettings | null = unsaved.value;
    buildSettings.value = { kind: 'ready', value: kept !== null && kept.buildId === id ? kept.settings : settings };
    await loadInPob(id, settings.lastTarget);
}

const SELECT_KEY: string = 'build-select';

/** Loads the build in PoB; the summary, or undefined when the load failed (already shown). */
async function loadInPob(id: string, target: string | null): Promise<BuildSummary | undefined> {
    let summary: BuildSummary;
    try {
        summary = await call('build.select', { buildId: id, target: target });
    } catch (error: unknown) {
        // PoB's own errors arrive as a build-state event and show under the form; the rest (a run going, the
        // save gone) would otherwise show nowhere.
        console.warn('build.select failed', messageOf(error));
        if (selectedBuildId.value === id && buildState.value.kind !== 'error') {
            notify('warn', `PoB didn't load the build: ${messageOf(error)}`, { key: SELECT_KEY });
        }
        return undefined;
    }
    dismissKey(SELECT_KEY);
    return summary;
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
        savedFor(id);
        if (selectedBuildId.value === id && readyValue(buildSettings.value) === next) {
            buildSettings.value = { kind: 'ready', value: saved };
        }
    } catch (error: unknown) {
        if (selectedBuildId.value === id) {
            buildSettings.value = { kind: 'ready', value: now };
        }
        throw error;
    }
}

/** A save went through: it carried any edits kept from a failed one too. */
function savedFor(id: string): void {
    if (unsaved.value?.buildId === id) {
        unsaved.value = null;
        dismissKey(UNSAVED_KEY);
    }
}

/**
 * Saves real work (a slot plan, weight edits, the level filter) in the selected build's settings. A failed
 * save keeps the edit on screen, marked unsaved, with a Retry: it never undoes itself (#43).
 */
export async function saveForBuild(change: Partial<BuildSettings>): Promise<void> {
    const id: string | null = selectedBuildId.value;
    const now: BuildSettings | undefined = readyValue(buildSettings.value);
    if (id === null || now === undefined) {
        return;
    }
    const next: BuildSettings = { ...now, ...change };
    buildSettings.value = { kind: 'ready', value: next };
    await saveKept(id, next);
}

async function saveKept(id: string, settings: BuildSettings): Promise<void> {
    try {
        const saved: BuildSettings = await call('build.settings.save', { buildId: id, settings: settings });
        savedFor(id);
        if (selectedBuildId.value === id && readyValue(buildSettings.value) === settings) {
            buildSettings.value = { kind: 'ready', value: saved };
        }
    } catch (error: unknown) {
        console.warn('could not save build settings', messageOf(error));
        unsaved.value = { buildId: id, settings: settings };
        const name: string = readyValue(buildsList.value)?.builds.find((b) => b.id === id)?.name ?? id;
        notify('error', `Your changes to ${name} aren't saved: ${messageOf(error)}`, {
            key: UNSAVED_KEY,
            action: { label: 'Retry', run: retrySave },
        });
    }
}

/** Saves the kept edits again: the build's current settings when it's selected, else the kept copy. */
export function retrySave(): void {
    const kept: UnsavedSettings | null = unsaved.value;
    if (kept === null) {
        return;
    }
    const current: BuildSettings | undefined = selectedBuildId.value === kept.buildId ? readyValue(buildSettings.value) : undefined;
    void saveKept(kept.buildId, current ?? kept.settings);
}

/** The Search view's small choices (slot, budget, target), remembered per build. Losing one isn't worth an error on screen: logged only. */
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
    // Shown at once; then the target PoB actually used is what stays remembered (#36). One it can't compute
    // (Full DPS with no group in Full DPS) loads as saved with a warning, and a failed load keeps the old one:
    // saving a failed target would only bring the failure back on every selection.
    const before: string | null = readyValue(buildSettings.value)?.lastTarget ?? null;
    await rememberForBuild({ lastTarget: target });
    const summary: BuildSummary | undefined = await loadInPob(id, target);
    if (selectedBuildId.value !== id) {
        return;
    }
    const used: string | null = summary === undefined ? before : summary.targetId;
    if (used !== target) {
        await rememberForBuild({ lastTarget: used });
    }
}

export function setSlot(slot: GearSlot): void {
    void rememberForBuild({ lastSlot: slot });
}
