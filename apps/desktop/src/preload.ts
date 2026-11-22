// The main window's preload (sandboxed, context-isolated). It exposes exactly two functions on window.uf
// and nothing of Node or Electron. It is generic, so new IPC methods need no change here; main checks every
// request. esbuild bundles it to dist/preload.cjs (a sandboxed preload must be one CommonJS file).

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { EVENT_CHANNEL, INVOKE_CHANNEL } from '@poe-upgrade-finder/ipc';
import type { UfBridge } from '@poe-upgrade-finder/ipc';

const bridge: UfBridge = {
    invoke(request: unknown): Promise<unknown> {
        return ipcRenderer.invoke(INVOKE_CHANNEL, request);
    },
    onEvent(listener: (event: unknown) => void): () => void {
        const handler = (_event: IpcRendererEvent, payload: unknown): void => {
            listener(payload);
        };
        ipcRenderer.on(EVENT_CHANNEL, handler);
        return (): void => {
            ipcRenderer.removeListener(EVENT_CHANNEL, handler);
        };
    },
};

contextBridge.exposeInMainWorld('uf', bridge);
