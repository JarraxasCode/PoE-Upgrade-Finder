// Messages on screen for things that failed (or that main reports), so nothing fails with no reason shown
// (#43). Shown by the notices strip in app.tsx. Info notices fade on their own; warnings and errors stay
// until dismissed or replaced.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { NoticeLevel } from '@poe-upgrade-finder/ipc';

export interface NoticeAction {
    readonly label: string;
    readonly run: () => void;
}

export interface Notice {
    readonly id: number;
    readonly level: NoticeLevel;
    readonly message: string;
    /** Notices with the same key replace each other (e.g. one "not saved" notice, however many saves fail). */
    readonly key: string | null;
    readonly action: NoticeAction | null;
}

export const notices: Signal<readonly Notice[]> = signal<readonly Notice[]>([]);

const INFO_MS: number = 8000;
const MAX_SHOWN: number = 4;
let nextId: number = 1;

export interface NotifyOptions {
    readonly key?: string;
    readonly action?: NoticeAction;
}

/** Shows a notice; returns its id. */
export function notify(level: NoticeLevel, message: string, options: NotifyOptions = {}): number {
    const id: number = nextId++;
    const key: string | null = options.key ?? null;
    const notice: Notice = { id: id, level: level, message: message, key: key, action: options.action ?? null };
    const kept: readonly Notice[] = notices.value.filter((n: Notice) => key === null || n.key !== key);
    notices.value = [...kept, notice].slice(-MAX_SHOWN);
    if (level === 'info') {
        setTimeout(() => {
            dismiss(id);
        }, INFO_MS);
    }
    return id;
}

export function dismiss(id: number): void {
    notices.value = notices.value.filter((n: Notice) => n.id !== id);
}

/** Removes the notice with this key, if any (e.g. once a failed save has gone through). */
export function dismissKey(key: string): void {
    notices.value = notices.value.filter((n: Notice) => n.key !== key);
}
