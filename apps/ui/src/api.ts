// The renderer's only way out: typed calls through window.uf (the preload's bridge). Every response and
// event is checked at runtime (packages/ipc) before the UI sees it.

import { METHOD_RESULTS, parseInvokeResponse, parseMainEvent } from '@poe-upgrade-finder/ipc';
import type { IpcErrorCode, IpcErrorInfo, MainEvent, MethodName, Params, Result, UfBridge } from '@poe-upgrade-finder/ipc';

declare global {
    interface Window {
        readonly uf?: UfBridge;
    }
}

export class IpcError extends Error {
    public override readonly name: string = 'IpcError';
    public readonly code: IpcErrorCode;

    public constructor(info: IpcErrorInfo) {
        super(info.message);
        this.code = info.code;
    }
}

function bridge(): UfBridge {
    const b: UfBridge | undefined = window.uf;
    if (b === undefined) {
        throw new Error('The app bridge is missing (the preload did not run).');
    }
    return b;
}

export async function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const response = parseInvokeResponse(await bridge().invoke({ method: method, params: params }));
    if (!response.ok) {
        throw new IpcError(response.error);
    }
    const check: (value: unknown, path: string) => Result<M> = METHOD_RESULTS[method];
    return check(response.result, method);
}

/** Subscribes to main's events; malformed ones are reported on the console and dropped. */
export function onMainEvent(listener: (event: MainEvent) => void): () => void {
    return bridge().onEvent((raw: unknown) => {
        let event: MainEvent | undefined;
        try {
            event = parseMainEvent(raw);
        } catch (error: unknown) {
            console.error('bad event from main', error);
            return;
        }
        if (event !== undefined) {
            listener(event);
        }
    });
}
