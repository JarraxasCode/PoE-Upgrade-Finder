// settings.json as the UI sees it.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { AppSettings } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import type { Loadable } from './loadable.ts';
import { messageOf } from './loadable.ts';

export const appSettings: Signal<Loadable<AppSettings>> = signal<Loadable<AppSettings>>({ kind: 'loading' });

export async function loadSettings(): Promise<void> {
    try {
        appSettings.value = { kind: 'ready', value: await call('settings.get', {}) };
    } catch (error: unknown) {
        appSettings.value = { kind: 'error', message: messageOf(error) };
    }
}

/** Saves; throws with a message for the form to show. */
export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
    const saved: AppSettings = await call('settings.save', { settings: settings });
    appSettings.value = { kind: 'ready', value: saved };
    return saved;
}
