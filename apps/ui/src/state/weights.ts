// The weight review on the Search view (PLAN.md, "Review PoB's weights before searching"): PoB's weights for
// the chosen build, slot and target, and the user's edits (kept per build and slot in BuildSettings).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { BuildSettings, WeightPreview } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { buildSettings, buildsList, saveForBuild } from './builds.ts';
import { readyValue } from './loadable.ts';
import { isEmptySlotPlan, planFor } from './plan.ts';
import { messageOf } from '@poe-upgrade-finder/validate';
import type { GearSlot, SlotPlan, WeightEdit, WeightEdits } from '@poe-upgrade-finder/vocab';

export type PreviewState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading'; readonly key: string }
    | { readonly kind: 'ready'; readonly key: string; readonly preview: WeightPreview }
    | { readonly kind: 'error'; readonly key: string; readonly message: string };

export const weightPreview: Signal<PreviewState> = signal<PreviewState>({ kind: 'idle' });

/** The slot's plan is part of the key: a changed plan reloads the review (it shows what the plan prunes). */
export function previewKey(buildId: string, slot: GearSlot, target: string): string {
    return `${previewBaseKey(buildId, slot, target)}|${JSON.stringify(planFor(slot))}`;
}

/**
 * The key without the plan: a review for it is worth keeping on screen while a plan edit reloads it. PoB's
 * weights change with the blend and the save too (#111), so both are in it; the save by its time, which main's
 * builds-changed event updates when PoB writes it again.
 */
export function previewBaseKey(buildId: string, slot: GearSlot, target: string): string {
    const blend: number | undefined = readyValue(buildSettings.value)?.blend;
    const saved: number | undefined = readyValue(buildsList.value)?.builds.find((b) => b.id === buildId)?.modifiedMs;
    return `${buildId}|${slot}|${target}|${blend ?? ''}|${saved ?? ''}`;
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
        const plan: SlotPlan = planFor(slot);
        const preview: WeightPreview = await call('weights.preview', {
            buildId: buildId,
            slot: slot,
            target: target,
            plan: isEmptySlotPlan(plan) ? null : plan,
        });
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
export function editsFor(slot: GearSlot): WeightEdits {
    return readyValue(buildSettings.value)?.weightEdits[slot] ?? {};
}

/** Sets one stat's edit (undefined clears it: back to PoB's weight, on). Saved per build at once. */
export function setWeightEdit(slot: GearSlot, statId: string, edit: WeightEdit | undefined): void {
    const settings: BuildSettings | undefined = readyValue(buildSettings.value);
    if (settings === undefined) {
        return;
    }
    const next: Record<string, WeightEdit> = { ...(settings.weightEdits[slot] ?? {}) };
    if (edit === undefined) {
        delete next[statId];
    } else {
        next[statId] = edit;
    }
    void saveForBuild({ weightEdits: { ...settings.weightEdits, [slot]: next } });
}

export function resetWeightEdits(slot: GearSlot): void {
    const settings: BuildSettings | undefined = readyValue(buildSettings.value);
    if (settings === undefined) {
        return;
    }
    const next: Partial<Record<GearSlot, WeightEdits>> = { ...settings.weightEdits };
    delete next[slot];
    void saveForBuild({ weightEdits: next });
}
