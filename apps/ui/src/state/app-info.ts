// The app's versions, loaded once from main, and the PoB update state (events from main keep it current).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { AppInfo, PobUpdateState } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import type { Loadable } from './loadable.ts';
import { messageOf } from '@poe-upgrade-finder/validate';

export const appInfo: Signal<Loadable<AppInfo>> = signal<Loadable<AppInfo>>({ kind: 'loading' });
export const pobUpdate: Signal<PobUpdateState | null> = signal<PobUpdateState | null>(null);

export async function loadAppInfo(): Promise<void> {
    try {
        appInfo.value = { kind: 'ready', value: await call('app.info', {}) };
    } catch (error: unknown) {
        appInfo.value = { kind: 'error', message: messageOf(error) };
    }
    try {
        pobUpdate.value = await call('pob.status', {});
    } catch {
        pobUpdate.value = null;
    }
}

/** A new PoB copy is live: About's version and licence come from it. */
export function setPobUpdate(state: PobUpdateState): void {
    const before: string | null = pobUpdate.value?.live ?? null;
    pobUpdate.value = state;
    if (state.live !== before) {
        void loadAppInfo();
    }
}
