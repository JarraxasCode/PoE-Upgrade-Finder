// Pause for a run (PLAN.md, UI: Pause/Cancel): while paused, no new trade call starts; a batch already
// fetched still finishes scoring. Cancel (the run's abort signal) releases anyone waiting with an error.

import { CancelledError } from '@poe-upgrade-finder/trade';

export class PauseGate {
    private waiters: { readonly resolve: () => void; readonly reject: (error: Error) => void }[] = [];
    private pausedNow: boolean = false;

    public get paused(): boolean {
        return this.pausedNow;
    }

    public pause(): void {
        this.pausedNow = true;
    }

    public resume(): void {
        this.pausedNow = false;
        const waiting = this.waiters;
        this.waiters = [];
        for (const w of waiting) {
            w.resolve();
        }
    }

    /** Resolves at once unless paused; then on resume. Rejects with CancelledError when the signal aborts. */
    public wait(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted === true) {
            return Promise.reject(new CancelledError());
        }
        if (!this.pausedNow) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            const entry = {
                resolve: (): void => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                },
                reject: reject,
            };
            const onAbort = (): void => {
                this.waiters = this.waiters.filter((w) => w !== entry);
                reject(new CancelledError());
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.waiters.push(entry);
        });
    }
}
