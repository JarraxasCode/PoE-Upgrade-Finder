// The main process's last line for errors that escape everything else (issue #63): a throw in a timer or an
// event callback, a promise nobody awaits. IPC handlers and runs catch their own; these didn't reach the log
// at all (Electron only showed its "A JavaScript error occurred in the main process" dialog).
//
// An unhandled rejection is logged and the app keeps running. An uncaught exception is logged, then onFatal
// runs (the app tells the user and exits): after one, Node's state can't be trusted.

import type { Logger } from '@poe-upgrade-finder/logging';
import { describeError, messageOf } from '@poe-upgrade-finder/validate';

/** The part of `process` used here, so tests can pass an EventEmitter. */
export interface ProcessEvents {
    on(event: 'uncaughtException', listener: (error: Error, origin: string) => void): unknown;
    on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

export interface ProcessErrorOptions {
    /** Area `main`. */
    readonly log: Logger;
    /** After an uncaught exception has been logged. */
    readonly onFatal: (error: Error) => void;
}

export function installProcessErrorHandlers(proc: ProcessEvents, options: ProcessErrorOptions): void {
    proc.on('unhandledRejection', (reason: unknown) => {
        options.log.log('error', 'unhandled promise rejection in the main process', {
            error: messageOf(reason),
            stack: describeError(reason),
        });
    });
    proc.on('uncaughtException', (error: Error, origin: string) => {
        try {
            options.log.log('error', 'uncaught exception in the main process', {
                origin: origin,
                error: messageOf(error),
                stack: describeError(error),
            });
        } finally {
            options.onFatal(error);
        }
    });
}
