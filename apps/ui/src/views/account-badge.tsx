// The pathofexile.com sign-in as an account badge at the top of the rail (Phase 4): a status
// dot always in view, and a panel with the details and the sign-in / sign-out actions on click. A native
// popover (light dismiss, Escape) placed against the badge by CSS anchor positioning.

import type { JSX } from 'preact';
import type { SignInState, SignInStatus } from '@poe-upgrade-finder/ipc';
import { checkSignIn, openSignIn, signIn, signOut, tradeError } from '../state/trade.ts';

const DOT: Readonly<Record<SignInStatus, 'ok' | 'warn' | 'fail' | 'busy'>> = {
    'signed-in': 'ok',
    'signed-out': 'warn',
    cloudflare: 'warn',
    'window-open': 'busy',
    checking: 'busy',
    unknown: 'busy',
    error: 'fail',
};

const HEADLINE: Readonly<Record<SignInStatus, string>> = {
    'signed-in': 'Signed in to pathofexile.com',
    'signed-out': 'Not signed in',
    cloudflare: 'pathofexile.com wants a Cloudflare check',
    'window-open': 'Signing in…',
    checking: 'Checking the sign-in…',
    unknown: 'Checking the sign-in…',
    error: "Couldn't check the sign-in",
};

function ago(ms: number): string {
    const s: number = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export function AccountBadge(): JSX.Element {
    const s: SignInState = signIn.value;
    const dot = DOT[s.status];
    return (
        <>
            <button
                type="button"
                class={`account-btn ${dot}`}
                popovertarget="account-panel"
                aria-label={`Trade account: ${HEADLINE[s.status]}`}
                title={HEADLINE[s.status]}
            >
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" class="account-icon">
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
                </svg>
                <span class={`account-dot ${dot}`} aria-hidden="true" />
            </button>
            <div id="account-panel" popover="auto" class="account-panel">
                <p class="account-head">
                    <span class={`account-dot inline ${dot}`} aria-hidden="true" />
                    {HEADLINE[s.status]}
                </p>
                {s.status === 'error' && s.message !== null && <p class="fail small">{s.message}</p>}
                {s.status === 'window-open' && (
                    <p class="small">Sign in in the pathofexile.com window and tick "Remember me"; it closes by itself.</p>
                )}
                {s.status === 'signed-in' && (
                    <p class="muted small">
                        Searches run as you, under your account's own trade rate limits. The session lasts 30 days if you ticked "Remember
                        me".
                    </p>
                )}
                {(s.status === 'signed-out' || s.status === 'cloudflare') && (
                    <p class="muted small">
                        The app signs in on pathofexile.com's own page, in a window of its own. It never sees your password.
                    </p>
                )}
                {s.checkedAtMs !== null && <p class="muted small">Checked {ago(s.checkedAtMs)}.</p>}
                <div class="account-actions">
                    {(s.status === 'signed-out' || s.status === 'cloudflare') && (
                        <button type="button" class="btn primary" onClick={() => void openSignIn()}>
                            {s.status === 'cloudflare' ? 'Open the site' : 'Sign in'}
                        </button>
                    )}
                    {s.status !== 'window-open' && s.status !== 'checking' && (
                        <button type="button" class="btn" onClick={() => void checkSignIn()}>
                            Check again
                        </button>
                    )}
                    {s.status === 'signed-in' && (
                        <button type="button" class="btn" onClick={() => void signOut()}>
                            Sign out…
                        </button>
                    )}
                </div>
                {s.status === 'signed-in' && (
                    <p class="muted small">Sign out logs you out of pathofexile.com and forgets the app's session.</p>
                )}
                {tradeError.value !== null && <p class="fail small">{tradeError.value}</p>}
            </div>
        </>
    );
}
