// Main's side of the IPC contract: one invoke handler that checks the sender and the request, runs the
// method's handler, and answers with an envelope. Handlers are typed by the contract, so a method without a
// handler doesn't compile.

import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { EVENT_CHANNEL, INVOKE_CHANNEL, parseInvokeRequest } from '@poe-upgrade-finder/ipc';
import type { InvokeRequest, InvokeResponse, MainEvent, MethodName, Params, Result } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { messageOf, ValidationError } from '@poe-upgrade-finder/validate';
import { UserFacingError } from './user-facing-error.ts';

export type Handlers = { readonly [M in MethodName]: (params: Params<M>) => Promise<Result<M>> };

export { UserFacingError } from './user-facing-error.ts';

function run<M extends MethodName>(handlers: Handlers, request: InvokeRequest<M>): Promise<Result<M>> {
    const handler: (params: Params<M>) => Promise<Result<M>> = handlers[request.method];
    return handler(request.params);
}

/**
 * Serves the invoke channel. `isTrusted` says whether a sender is our own window (only the main window's
 * top frame, loaded from our files, may call; the sign-in window never can).
 */
export function serveIpc(
    handlers: Handlers,
    isTrusted: (event: IpcMainInvokeEvent) => boolean,
    logger: Logger,
    onRefused?: (message: string) => void,
): () => void {
    ipcMain.handle(INVOKE_CHANNEL, async (event: IpcMainInvokeEvent, raw: unknown): Promise<InvokeResponse> => {
        if (!isTrusted(event)) {
            logger.log('warn', 'IPC from an untrusted sender refused', { url: event.senderFrame?.url ?? null });
            onRefused?.('IPC from an untrusted sender refused');
            return { ok: false, error: { code: 'not-allowed', message: 'Not allowed from this window.' } };
        }
        let request: InvokeRequest;
        try {
            request = parseInvokeRequest(raw);
        } catch (error: unknown) {
            const message: string = error instanceof ValidationError ? error.message : String(error);
            logger.log('warn', 'bad IPC request', { message: message });
            onRefused?.(`bad IPC request: ${message}`);
            return { ok: false, error: { code: 'bad-request', message: message } };
        }
        const started: number = Date.now();
        try {
            const result: unknown = await run(handlers, request);
            logger.log('debug', `ipc ${request.method}`, { ms: Date.now() - started });
            return { ok: true, result: result };
        } catch (error: unknown) {
            const message: string = messageOf(error);
            logger.log(error instanceof UserFacingError ? 'warn' : 'error', `ipc ${request.method} failed`, {
                message: message,
                stack: error instanceof Error && !(error instanceof UserFacingError) ? (error.stack ?? null) : null,
            });
            return { ok: false, error: { code: 'failed', message: message } };
        }
    });
    return (): void => {
        ipcMain.removeHandler(INVOKE_CHANNEL);
    };
}

export function sendEvent(contents: WebContents | undefined, event: MainEvent): void {
    if (contents !== undefined && !contents.isDestroyed()) {
        contents.send(EVENT_CHANNEL, event);
    }
}
