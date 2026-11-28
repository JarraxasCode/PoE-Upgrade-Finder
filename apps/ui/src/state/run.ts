// The current (or last) run as the Run view sees it, kept up to date from main's run events.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { LimitPanel, RunEventUi, RunHeader, RunRequest, RunSnapshot } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { messageOf } from '@poe-upgrade-finder/validate';
import { notify } from './notices.ts';

export const run: Signal<RunSnapshot | null> = signal<RunSnapshot | null>(null);
export const limits: Signal<LimitPanel | null> = signal<LimitPanel | null>(null);
/** The Search button's state while a run is being prepared. */
export const starting: Signal<{ readonly busy: boolean; readonly error: string | null }> = signal({ busy: false, error: null });
/** A message about the last buy-link click, by item id. */
export const linkMessage: Signal<{ readonly itemId: string; readonly text: string } | null> = signal(null);

export async function loadRun(): Promise<void> {
    try {
        const [snap, panel] = await Promise.all([call('run.current', {}), call('run.limits', {})]);
        run.value = snap;
        limits.value = panel;
    } catch (error: unknown) {
        console.warn('could not load the run', messageOf(error));
        notify('warn', `Couldn't load the last run: ${messageOf(error)}`);
    }
}

export async function startRun(request: RunRequest): Promise<RunHeader | undefined> {
    starting.value = { busy: true, error: null };
    try {
        const header: RunHeader = await call('run.start', { request: request });
        starting.value = { busy: false, error: null };
        return header;
    } catch (error: unknown) {
        starting.value = { busy: false, error: messageOf(error) };
        return undefined;
    }
}

/** Search deeper on the finished run; an error shows under the button. */
export const deepening: Signal<{ readonly busy: boolean; readonly error: string | null }> = signal({ busy: false, error: null });

export async function deepenRun(runId: string): Promise<void> {
    deepening.value = { busy: true, error: null };
    try {
        await call('run.deepen', { runId: runId });
        deepening.value = { busy: false, error: null };
    } catch (error: unknown) {
        deepening.value = { busy: false, error: messageOf(error) };
    }
}

/** A run control (pause, resume, cancel); a failure says so on screen. */
async function control(method: 'run.pause' | 'run.resume' | 'run.cancel', what: string): Promise<void> {
    try {
        await call(method, {});
    } catch (error: unknown) {
        notify('error', `Couldn't ${what} the run: ${messageOf(error)}`, { key: 'run-control' });
    }
}

export function pauseRun(): void {
    void control('run.pause', 'pause');
}

export function resumeRun(): void {
    void control('run.resume', 'resume');
}

export function cancelRun(): void {
    void control('run.cancel', 'cancel');
}

export async function openBuyLink(runId: string, itemId: string): Promise<void> {
    linkMessage.value = { itemId: itemId, text: 'Opening in your browser…' };
    try {
        const r = await call('link.open', { runId: runId, itemId: itemId });
        linkMessage.value = r.opened ? null : { itemId: itemId, text: r.message ?? 'Not opened.' };
    } catch (error: unknown) {
        linkMessage.value = { itemId: itemId, text: messageOf(error) };
    }
}

/** Applies one run event to the snapshot (events for another run are ignored, except a new start). */
export function applyRunEvent(event: RunEventUi): void {
    if (event.kind === 'run-started') {
        run.value = { header: event.header, phase: 'searching', searches: [], items: [], bandsDone: [], feed: [], summary: null };
        return;
    }
    const now: RunSnapshot | null = run.value;
    if (now === null || now.header.runId !== event.runId) {
        return;
    }
    switch (event.kind) {
        case 'run-phase':
            run.value = { ...now, phase: event.phase };
            break;
        case 'run-search':
            run.value = { ...now, searches: [...now.searches, event.search] };
            break;
        case 'run-item':
            run.value = { ...now, items: [...now.items, event.item] };
            break;
        case 'run-band-done':
            run.value = { ...now, bandsDone: [...now.bandsDone, event.bandId] };
            break;
        case 'run-feed':
            run.value = { ...now, feed: [...now.feed.slice(-299), event.entry] };
            break;
        case 'run-done':
            run.value = { ...now, summary: event.summary };
            break;
        case 'run-deepen':
            run.value = { ...now, header: event.header, searches: [...event.searches], bandsDone: [], summary: null, phase: 'searching' };
            break;
    }
}
