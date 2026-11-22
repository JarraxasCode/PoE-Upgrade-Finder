// The log line the Logs card should open at (set by a feed warning or error in the Run view, read once).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { LogFocus } from '../log-focus.ts';
import { go } from '../router.ts';

export const logFocus: Signal<LogFocus | null> = signal<LogFocus | null>(null);

export function openLogLine(focus: LogFocus): void {
    logFocus.value = focus;
    go('settings');
}
