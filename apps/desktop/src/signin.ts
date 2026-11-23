// Sign-in (PLAN.md, D10): pathofexile.com's own login page in an app window on the isolated partition. The
// app never handles the password and injects nothing into the page. Signed-in state comes from a trade
// call's rate-limit rules (Account present), never from the cookie (V15).

import { app, BrowserWindow } from 'electron';
import type { Event, WebContents, WebPreferences } from 'electron';
import { POE_ORIGIN, TradeClient, TradeError } from '@poe-upgrade-finder/trade';
import type { TradeLogger, TradeSearchBody } from '@poe-upgrade-finder/trade';
import { isAllowedSignInUrl } from './signin-hosts.ts';
import { APP_ICON_FILE } from './ui/main-window.ts';

export const TRADE_PARTITION: string = 'persist:poe-trade';

/** The smallest signed-in-only question: one search (through the shared limiter), cheapest boots, 1c max. */
const PROBE: TradeSearchBody = {
    query: {
        status: { option: 'securable' },
        stats: [{ type: 'and', filters: [] }],
        filters: {
            type_filters: { filters: { category: { option: 'armour.boots' }, rarity: { option: 'nonunique' } } },
            trade_filters: { filters: { price: { max: 1, option: 'chaos' } } },
        },
    },
    sort: { price: 'asc' },
};

export type SignInState = 'signed-in' | 'signed-out' | 'cloudflare';

export async function probeSignIn(client: TradeClient, league: string): Promise<SignInState> {
    try {
        await client.search(league, PROBE);
        return client.signedIn === true ? 'signed-in' : 'signed-out';
    } catch (error: unknown) {
        if (error instanceof TradeError && error.code === 'cloudflare') {
            return 'cloudflare';
        }
        if (error instanceof TradeError && (error.code === 'signed-out' || error.code === 'redirect')) {
            return 'signed-out';
        }
        throw error;
    }
}

const NOTE: string = 'Tick "Remember me" to stay signed in when you close the app';

/** Opens the login page; resolves when the window closes (by itself after sign-in, or by the user). Sign-out
 * needs no window (signout.ts). */
export function openSignInWindow(logger: TradeLogger): Promise<void> {
    const note: string = NOTE;
    return new Promise<void>((resolve: () => void) => {
        const prefs: WebPreferences = { partition: TRADE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true };
        const win: BrowserWindow = new BrowserWindow({
            width: 1000,
            height: 860,
            center: true,
            show: false,
            icon: APP_ICON_FILE,
            title: `Sign in to pathofexile.com. ${note}`,
            webPreferences: prefs,
        });
        // Started from a terminal, Windows won't let the app take the foreground, so the window opened behind
        // everything (22 Nov). Bring it up on top for a moment, take focus, and flash the taskbar button.
        win.once('ready-to-show', () => {
            win.show();
            win.setAlwaysOnTop(true);
            app.focus({ steal: true });
            win.focus();
            win.flashFrame(true);
            setTimeout(() => {
                if (!win.isDestroyed()) {
                    win.setAlwaysOnTop(false);
                }
            }, 3000);
        });
        win.on('focus', () => {
            win.flashFrame(false);
        });
        const contents: WebContents = win.webContents;
        logger.log('info', 'Sign-in window opened');
        guardContents(contents, logger, prefs);
        contents.on('page-title-updated', (event: Event) => {
            event.preventDefault();
        });
        contents.on('did-navigate', (_event: Event, url: string) => {
            const u: URL = new URL(url);
            win.setTitle(`${u.host}${u.pathname} | ${note}`);
            logger.log('info', 'sign-in navigate', { host: u.host, path: u.pathname });
            if (url.startsWith(`${POE_ORIGIN}/my-account`)) {
                logger.log('info', 'reached My Account: sign-in looks complete, closing the window');
                setTimeout(() => {
                    if (!win.isDestroyed()) {
                        win.close();
                    }
                }, 1500);
            }
        });
        win.on('closed', () => {
            logger.log('info', 'Sign-in window closed');
            resolve();
        });
        void win.loadURL(`${POE_ORIGIN}/login`);
    });
}

/**
 * Keeps a sign-in window (and every pop-up it opens, to any depth) on the allowed hosts. Login providers may
 * open pop-ups: they get the same isolated session and the same guard, attached here as each one is created.
 */
function guardContents(contents: WebContents, logger: TradeLogger, prefs: WebPreferences): void {
    const guard = (event: Event, url: string): void => {
        if (!isAllowedSignInUrl(url)) {
            event.preventDefault();
            logger.log('warn', 'sign-in navigation blocked', { host: safeHost(url) });
        }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler((details: { readonly url: string }) => {
        if (!isAllowedSignInUrl(details.url)) {
            logger.log('warn', 'sign-in pop-up blocked', { host: safeHost(details.url) });
            return { action: 'deny' };
        }
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: prefs } };
    });
    contents.on('did-create-window', (child: BrowserWindow) => {
        guardContents(child.webContents, logger, prefs);
    });
}

function safeHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return '(bad url)';
    }
}
