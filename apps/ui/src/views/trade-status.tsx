// Sign-in status and the divine rate, under the Search form (PLAN.md, UI: sign-in status; Prices: the rate is
// automatic from GGG, the user can always override it). Also used in Settings (trade account).

import { useEffect, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import type { RateState, SignInState } from '@poe-upgrade-finder/ipc';
import { parseNumberText } from '../floors-form.ts';
import { Orb } from './price.tsx';
import { checkSignIn, openSignIn, rate, refreshRate, setManualRate, signIn, signOut, tradeError, useGggRate } from '../state/trade.ts';

function hourLabel(ms: number): string {
    return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

export function SignInLine(props: { readonly showSignOut?: boolean }): JSX.Element {
    const s: SignInState = signIn.value;
    switch (s.status) {
        case 'signed-in':
            return (
                <p class="line">
                    <span class="pass">Signed in to pathofexile.com</span>
                    {props.showSignOut === true && (
                        <> · <button type="button" class="link" onClick={() => void signOut()}>Sign out…</button></>
                    )}
                </p>
            );
        case 'checking':
        case 'unknown':
            return <p class="line muted">Checking the pathofexile.com sign-in…</p>;
        case 'window-open':
            return <p class="line muted">The pathofexile.com window is open. Sign in there and tick "Remember me"; it closes by itself.</p>;
        case 'cloudflare':
            return (
                <p class="line warn">
                    pathofexile.com wants a Cloudflare check. <button type="button" class="link" onClick={() => void openSignIn()}>Open the site</button>
                </p>
            );
        case 'signed-out':
            return (
                <p class="line warn">
                    Not signed in to pathofexile.com. <button type="button" class="link" onClick={() => void openSignIn()}>Sign in</button>
                </p>
            );
        case 'error':
            return (
                <p class="line fail">
                    Couldn't check the sign-in: {s.message ?? 'unknown error'}. <button type="button" class="link" onClick={() => void checkSignIn()}>Try again</button>
                </p>
            );
    }
}

function useNow(everyMs: number): number {
    const [now, setNow] = useState<number>(Date.now());
    useEffect(() => {
        const t: ReturnType<typeof setInterval> = setInterval(() => {
            setNow(Date.now());
        }, everyMs);
        return () => {
            clearInterval(t);
        };
    }, [everyMs]);
    return now;
}

export function RateLine(): JSX.Element {
    const r: RateState | null = rate.value;
    const [editing, setEditing] = useState<boolean>(false);
    const [text, setText] = useState<string>('');
    const now: number = useNow(1000);
    if (r === null) {
        return <p class="line muted">Divine rate: not looked up yet.</p>;
    }
    const blockedFor: number = r.refreshBlockedUntilMs === null ? 0 : Math.ceil((r.refreshBlockedUntilMs - now) / 1000);
    const typed: number | undefined = parseNumberText(text);
    const submit = (): void => {
        if (typed !== undefined && typed >= 1) {
            void setManualRate(typed).then(() => {
                setEditing(false);
            });
        }
    };
    return (
        <div class="line rate">
            <span>
                Divine rate:{' '}
                {r.rate === null ? (
                    <span class="warn">unknown, only chaos-priced listings will be searched</span>
                ) : (
                    <>
                        <span class="rate-orbs"><Orb currency="divine" amount={1} /> = <Orb currency="chaos" amount={Number(r.rate.chaosPerDivine.toFixed(1))} /></span>
                        <span class="muted"> ({r.rate.source === 'ggg' ? `GGG Currency Exchange${r.rate.hourMs === null ? '' : `, hour of ${hourLabel(r.rate.hourMs)}`}` : 'typed in'})</span>
                    </>
                )}
                {r.busy && <span class="muted"> · looking up…</span>}
            </span>
            {!editing && (
                <span class="rate-actions">
                    {r.rate?.source !== 'manual' && (
                        <button type="button" class="link" disabled={r.busy || blockedFor > 0} onClick={() => void refreshRate()} title="At most once every 30 s">
                            {blockedFor > 0 ? `Refresh (${blockedFor}s)` : 'Refresh'}
                        </button>
                    )}
                    <button type="button" class="link" onClick={() => {
                        setText(r.rate === null ? '' : r.rate.chaosPerDivine.toFixed(0));
                        setEditing(true);
                    }}>Type one in</button>
                    {r.rate?.source === 'manual' && <button type="button" class="link" disabled={r.busy} onClick={() => void useGggRate()}>Use GGG's rate</button>}
                </span>
            )}
            {editing && (
                <form class="rate-form" onSubmit={(e: TargetedEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    submit();
                }}>
                    <input class="num small" aria-label="Chaos per divine" inputMode="decimal" value={text} aria-invalid={text !== '' && (typed === undefined || typed < 1)} onInput={(e: TargetedEvent<HTMLInputElement>) => {
                        setText(e.currentTarget.value);
                    }} />
                    <span class="muted">chaos per divine</span>
                    <button type="submit" class="btn" disabled={typed === undefined || typed < 1}>Use it</button>
                    <button type="button" class="btn" onClick={() => {
                        setEditing(false);
                    }}>Cancel</button>
                </form>
            )}
            {r.error !== null && <span class="warn block">{r.error}</span>}
        </div>
    );
}

export function TradeError(): JSX.Element | null {
    return tradeError.value === null ? null : <p class="line fail">{tradeError.value}</p>;
}
