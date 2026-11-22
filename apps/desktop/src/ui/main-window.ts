// The main window: the renderer from apps/ui/dist on the default session (never the trade partition),
// sandboxed and context-isolated, with the preload as its only bridge. It can't navigate anywhere or open
// windows; buy links go to the user's own browser through main (shell.openExternal, checked there).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';
import type { Event, IpcMainInvokeEvent, WebContentsConsoleMessageEventParams } from 'electron';
import { repoRoot } from '@poe-upgrade-finder/engine-client';
import type { Logger } from '@poe-upgrade-finder/logging';

// From the app root, not import.meta: main runs as one bundle in the packaged app.
const DESKTOP_DIR: string = join(repoRoot(), 'apps', 'desktop');
/** The app icon (assets/icon, built by tools/icon) for the window and taskbar. */
export const APP_ICON_FILE: string = join(repoRoot(), 'assets', 'icon', 'icon.ico');
export const PRELOAD_FILE: string = join(DESKTOP_DIR, 'dist', 'preload.cjs');
export const UI_INDEX_FILE: string = resolve(DESKTOP_DIR, '..', 'ui', 'dist', 'index.html');

export class MissingBuildError extends Error {
    public override readonly name: string = 'MissingBuildError';
}

export interface MainWindowOptions {
    readonly logger: Logger;
    /** Paint while hidden (the smoke check captures the page without showing the window). */
    readonly hidden?: boolean;
    /** Called for each renderer console error and crash (the smoke check fails on any). */
    readonly onProblem?: (message: string) => void;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
    for (const file of [PRELOAD_FILE, UI_INDEX_FILE]) {
        if (!existsSync(file)) {
            throw new MissingBuildError(`${file} is missing: run npm run ui:build first (npm run app does it).`);
        }
    }
    const log: Logger = options.logger;
    // Big enough that the Search and Run views fit without scrolling, but never beyond the screen's work area.
    const area: Electron.Size = screen.getPrimaryDisplay().workAreaSize;
    const win: BrowserWindow = new BrowserWindow({
        width: Math.min(1440, Math.round(area.width * 0.9)),
        height: Math.min(1000, Math.round(area.height * 0.94)),
        center: true,
        minWidth: 900,
        minHeight: 600,
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#111318',
        title: 'PoE Upgrade Finder',
        icon: APP_ICON_FILE,
        autoHideMenuBar: true,
        webPreferences: {
            preload: PRELOAD_FILE,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false,
            // A hidden (smoke) window would otherwise pause its frames and leave the page on an old state.
            backgroundThrottling: options.hidden !== true,
        },
    });
    win.setMenu(null);
    if (options.hidden !== true) {
        win.once('ready-to-show', () => {
            win.show();
        });
    } else {
        // Smoke checks: a never-shown window keeps compositing its first frames only, so captures go stale. Show it
        // fully transparent, unfocused and off the taskbar instead: it paints normally and nobody sees it.
        win.setOpacity(0);
        win.setSkipTaskbar(true);
        win.setFocusable(false);
        win.once('ready-to-show', () => {
            win.showInactive();
        });
    }
    const contents = win.webContents;
    contents.on('will-navigate', (event: Event, url: string) => {
        if (url !== contents.getURL()) {
            event.preventDefault();
            log.log('warn', 'main window navigation blocked', { url: url.startsWith('file:') ? 'file:' : url });
        }
    });
    contents.setWindowOpenHandler(() => {
        log.log('warn', 'main window pop-up blocked');
        return { action: 'deny' };
    });
    contents.on('console-message', (details: Event<WebContentsConsoleMessageEventParams>) => {
        const level = details.level === 'error' ? 'error' : details.level === 'warning' ? 'warn' : 'debug';
        log.log(level, 'renderer console', { message: details.message, line: details.lineNumber });
        if (level === 'error') {
            options.onProblem?.(`renderer console: ${details.message}`);
        }
    });
    contents.on('render-process-gone', (_event: Event, details: { readonly reason: string; readonly exitCode: number }) => {
        log.log('error', 'renderer gone', { reason: details.reason, exitCode: details.exitCode });
        options.onProblem?.(`renderer gone: ${details.reason}`);
    });
    void win.loadFile(UI_INDEX_FILE);
    return win;
}

/** Only the main window's top frame, showing our own page, may use IPC. */
export function isMainWindowSender(win: BrowserWindow | undefined, event: IpcMainInvokeEvent): boolean {
    if (win === undefined || win.isDestroyed() || event.sender !== win.webContents) {
        return false;
    }
    const frame = event.senderFrame;
    return frame !== null && frame === win.webContents.mainFrame && isUiIndexUrl(frame.url);
}

/** Whether a URL is our index.html. Windows paths ignore case, and Chromium upper-cases the drive letter. */
export function isUiIndexUrl(url: string): boolean {
    if (!url.startsWith('file:')) {
        return false;
    }
    try {
        const path: string = resolve(fileURLToPath(url.split('#')[0] ?? ''));
        return path.toLowerCase() === UI_INDEX_FILE.toLowerCase();
    } catch {
        return false;
    }
}
