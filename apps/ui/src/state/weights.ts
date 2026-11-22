// The weight review on the Search view (PLAN.md, "Review PoB's weights before searching"): PoB's weights for
// the chosen build, slot and target, and the user's edits (kept per build and slot in BuildSettings).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { BuildSettings, GearSlot, WeightPreview } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { buildSettings, rememberForBuild } from './builds.ts';
import { readyValue } from './loadable.ts';
import { messageOf } from './loadable.ts';

export type PreviewState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading'; readonly key: string }
    | { readonly kind: 'ready'; readonly key: string; readonly preview: WeightPreview }
    | { readonly kind: 'error'; readonly key: string; readonly message: string };

export const weightPreview: Signal<PreviewState> = signal<PreviewState>({ kind: 'idle' });

export function previewKey(buildId: string, slot: GearSlot, target: string): string {
    return `${buildId}|${slot}|${target}`;
}

/** Asks main for PoB's weights (the generator, about 1 s, cached after). Only the latest request lands. */
export async function loadWeightPreview(buildId: string, slot: GearSlot, target: string): Promise<void> {
    const key: string = previewKey(buildId, slot, target);
    const now: PreviewState = weightPreview.value;
    if (now.kind !== 'idle' && now.key === key && now.kind !== 'error') {
        return;
    }
    weightPreview.value = { kind: 'loading', key: key };
    try {
        const preview: WeightPreview = await call('weights.preview', { buildId: buildId, slot: slot, target: target });
        if (weightPreview.value.kind === 'loading' && weightPreview.value.key === key) {
            weightPreview.value = { kind: 'ready', key: key, preview: preview };
        }
    } catch (error: unknown) {
        if (weightPreview.value.kind === 'loading' && weightPreview.value.key === key) {
            weightPreview.value = { kind: 'error', key: key, message: messageOf(error) };
        }
    }
}

/** The edits for a slot, from the selected build's settings. */
export function editsFor(slot: GearSlot): Readonly<Record<string, number>> {
    return readyValue(buildSettings.value)?.weightEdits[slot] ?? {};
}

/** Sets one stat's edit (undefined clears it: back to PoB's weight). Saved per build at once. */
export function setWeightEdit(slot: GearSlot, statId: string, weight: number | undefined): void {
    const settings: BuildSettings | undefined = readyValue(buildSettings.value);
    if (settings === undefined) {
        return;
    }
    const next: Record<string, number> = { ...(settings.weightEdits[slot] ?? {}) };
    if (weight === undefined) {
        delete next[statId];
    } else {
        next[statId] = weight;
    }
    void rememberForBuild({ weightEdits: { ...settings.weightEdits, [slot]: next } });
}

export function resetWeightEdits(slot: GearSlot): void {
    const settings: BuildSettings | undefined = readyValue(buildSettings.value);
    if (settings === undefined) {
        return;
    }
    const next: Partial<Record<GearSlot, Readonly<Record<string, number>>>> = { ...settings.weightEdits };
    delete next[slot];
    void rememberForBuild({ weightEdits: next });
}
