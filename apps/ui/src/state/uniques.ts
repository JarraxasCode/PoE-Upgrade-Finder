// The unique search on the Search view (#113): each slot's Rare / Unique switch and picked unique, kept per build
// and slot in BuildSettings beside the rare plan, and PoB's list of uniques for the slot's item type.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { BuildSettings, UniqueList } from '@poe-upgrade-finder/ipc';
import { messageOf } from '@poe-upgrade-finder/validate';
import type { GearSlot, PickedUnique, UniqueChoice, UniqueMode } from '@poe-upgrade-finder/vocab';
import { call } from '../api.ts';
import { buildSettings, buildsList, saveForBuild } from './builds.ts';
import { readyValue } from './loadable.ts';

export type UniqueListState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading'; readonly key: string }
    | { readonly kind: 'ready'; readonly key: string; readonly list: UniqueList }
    | { readonly kind: 'error'; readonly key: string; readonly message: string };

export const uniqueList: Signal<UniqueListState> = signal<UniqueListState>({ kind: 'idle' });

/** The selected build's choice for a slot; none: Rare. */
export function uniqueChoiceFor(slot: GearSlot): UniqueChoice | undefined {
    return readyValue(buildSettings.value)?.uniqueChoices[slot];
}

function saveChoice(slot: GearSlot, choice: UniqueChoice): void {
    const settings: BuildSettings | undefined = readyValue(buildSettings.value);
    if (settings === undefined) {
        return;
    }
    void saveForBuild({ uniqueChoices: { ...settings.uniqueChoices, [slot]: choice } });
}

/** Flips the slot's switch; the picked unique (and the rare plan) are kept either way. */
export function setUniqueMode(slot: GearSlot, mode: UniqueMode): void {
    saveChoice(slot, { mode: mode, unique: uniqueChoiceFor(slot)?.unique ?? null });
}

export function pickUnique(slot: GearSlot, unique: PickedUnique): void {
    saveChoice(slot, { mode: 'unique', unique: unique });
}

/** PoB's scores change with the blend and the save, so both are in the key (as for the weight review). */
export function uniqueListKey(buildId: string, slot: GearSlot, target: string, itemType: string): string {
    const blend: number | undefined = readyValue(buildSettings.value)?.blend;
    const saved: number | undefined = readyValue(buildsList.value)?.builds.find((b) => b.id === buildId)?.modifiedMs;
    return `${buildId}|${slot}|${target}|${itemType}|${blend ?? ''}|${saved ?? ''}`;
}

/** Asks main for the slot's uniques (PoB scores each, about 0.5 s for 80, cached after). Only the latest lands. */
export async function loadUniqueList(buildId: string, slot: GearSlot, target: string, itemType: string): Promise<void> {
    const key: string = uniqueListKey(buildId, slot, target, itemType);
    const now: UniqueListState = uniqueList.value;
    if (now.kind !== 'idle' && now.kind !== 'error' && now.key === key) {
        return;
    }
    uniqueList.value = { kind: 'loading', key: key };
    try {
        const list: UniqueList = await call('uniques.list', { buildId: buildId, slot: slot, target: target, itemType: itemType });
        if (uniqueList.value.kind === 'loading' && uniqueList.value.key === key) {
            uniqueList.value = { kind: 'ready', key: key, list: list };
        }
    } catch (error: unknown) {
        if (uniqueList.value.kind === 'loading' && uniqueList.value.key === key) {
            uniqueList.value = { kind: 'error', key: key, message: messageOf(error) };
        }
    }
}
