// Sign out without a window. My Account's Log out button is a plain POST form to /logout
// with two hidden fields (poe1=1, locale) and no CSRF token (checked 22 Nov). V15 showed that /logout ends
// the session on the site, not only in the cookie jar. So the app sends that same POST on the trade
// partition, doesn't follow the redirect (the site now redirects through pathofexile2.com), and then clears
// the partition whatever the answer. Nothing but the status and the redirect's host is logged.

import { net } from 'electron';
import type { ClientRequest, IncomingMessage, Session } from 'electron';
import { POE_ORIGIN } from '@poe-upgrade-finder/trade';

export type LogoutOutcome =
    | { readonly kind: 'redirect'; readonly status: number; readonly host: string }
    | { readonly kind: 'response'; readonly status: number }
    | { readonly kind: 'failed'; readonly message: string };

/** The form's fields as the site sends them. */
export const LOGOUT_BODY: string = 'poe1=1&locale=en_US';

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return '?';
    }
}

export function postLogout(session: Session, timeoutMs: number = 15_000): Promise<LogoutOutcome> {
    return new Promise<LogoutOutcome>((resolve: (outcome: LogoutOutcome) => void) => {
        let done: boolean = false;
        const req: ClientRequest = net.request({
            method: 'POST',
            url: `${POE_ORIGIN}/logout`,
            session: session,
            useSessionCookies: true,
            redirect: 'manual',
        });
        const finish = (outcome: LogoutOutcome): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            req.abort();
            resolve(outcome);
        };
        const timer: NodeJS.Timeout = setTimeout(() => {
            finish({ kind: 'failed', message: 'timed out' });
        }, timeoutMs);
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
        req.setHeader('Origin', POE_ORIGIN);
        req.setHeader('Referer', `${POE_ORIGIN}/my-account`);
        req.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
            finish({ kind: 'redirect', status: statusCode, host: hostOf(redirectUrl) });
        });
        req.on('response', (response: IncomingMessage) => {
            finish({ kind: 'response', status: response.statusCode });
        });
        req.on('error', (error: Error) => {
            finish({ kind: 'failed', message: error.message });
        });
        req.end(LOGOUT_BODY);
    });
}
