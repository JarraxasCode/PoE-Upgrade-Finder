// The slot plan per slot (PLAN.md, "v2a: the slot plan"), saved in the build's settings, and the editor's data
// for it (`slot.data`). A slot with no plan, or an empty one, searches as v0.1 did.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { emptySlotPlan } from '@poe-upgrade-finder/ipc';
import type { BuildSettings, GearSlot, SlotEditorData, SlotPlan } from '@poe-upgrade-finder/ipc';
import { messageOf } from '@poe-upgrade-finder/validate';
import { call } from '../api.ts';
import { setDefences } from '../slot-plan-model.ts';
import { buildSettings, rememberForBuild } from './builds.ts';
import { readyValue } from './loadable.ts';

/** The selected build's plan for a slot, or an empty one. */
export function planFor(slot: GearSlot): SlotPlan {
    return readyValue(buildSettings.value)?.slotPlans[slot] ?? emptySlotPlan(slot);
}

/** An empty plan: no item type, no base, no mods, no defences (searches as v0.1 did). */
export function isEmptySlotPlan(plan: SlotPlan): boolean {
    return (
        plan.itemType === null &&
        plan.base === null &&
        plan.picks.length === 0 &&
        setDefences(plan).length === 0 &&
        (plan.totals ?? []).length === 0
    );
}

/** Saves a slot's plan in the build's settings at once; an empty plan is removed. */
export function setSlotPlan(plan: SlotPlan): void {
    const settings: BuildSettings | undefined = readyValue(buildSettings.value);
    if (settings === undefined) {
        return;
    }
    const next: Partial<Record<GearSlot, SlotPlan>> = { ...settings.slotPlans };
    if (isEmptySlotPlan(plan)) {
        delete next[plan.slot];
    } else {
        next[plan.slot] = plan;
    }
    void rememberForBuild({ slotPlans: next });
}

export type EditorDataState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading'; readonly key: string }
    | { readonly kind: 'ready'; readonly key: string; readonly data: SlotEditorData }
    | { readonly kind: 'error'; readonly key: string; readonly message: string };

export const editorData: Signal<EditorDataState> = signal<EditorDataState>({ kind: 'idle' });

/** Loaded data, kept for the session: switching the base back and forth doesn't ask main again. */
const loaded: Map<string, SlotEditorData> = new Map<string, SlotEditorData>();

export function editorDataKey(slot: GearSlot, itemType: string, base: string | null): string {
    return `${slot}|${itemType}|${base ?? ''}`;
}

/** Asks main for the editor's data (the first call per item type runs PoB, 1 to 5 s). Only the latest lands. */
export async function loadEditorData(slot: GearSlot, itemType: string, base: string | null): Promise<void> {
    const key: string = editorDataKey(slot, itemType, base);
    const now: EditorDataState = editorData.value;
    if ((now.kind === 'ready' || now.kind === 'loading') && now.key === key) {
        return;
    }
    const have: SlotEditorData | undefined = loaded.get(key);
    if (have !== undefined) {
        editorData.value = { kind: 'ready', key: key, data: have };
        return;
    }
    editorData.value = { kind: 'loading', key: key };
    try {
        const data: SlotEditorData = await call('slot.data', { slot: slot, itemType: itemType, base: base });
        loaded.set(key, data);
        if (editorData.value.kind === 'loading' && editorData.value.key === key) {
            editorData.value = { kind: 'ready', key: key, data: data };
        }
    } catch (error: unknown) {
        if (editorData.value.kind === 'loading' && editorData.value.key === key) {
            editorData.value = { kind: 'error', key: key, message: messageOf(error) };
        }
    }
}
