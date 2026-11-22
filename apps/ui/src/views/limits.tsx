// The trade site's rate limits (PLAN.md, Trade client): each window as a meter. In full on the Run view while
// a run goes; otherwise a slim strip at the top of the Search and Run views (the longer windows, which carry
// over into the next run), opening to every window.

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { LimitPanel, LimitPolicy, LimitWindow } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { limits } from '../state/run.ts';

const POLICY_NAMES: Readonly<Record<string, string>> = { search: 'Searches', fetch: 'Fetches' };

function periodText(s: number): string {
    return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

export function useNow(everyMs: number): number {
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

/** A window's use as a tone: blue, amber from 75%, red when full. */
export function usageTone(w: LimitWindow): 'ok' | 'high' | 'full' {
    return w.count >= w.allowed ? 'full' : w.count >= w.allowed * 0.75 ? 'high' : 'ok';
}

function Bar(props: { readonly w: LimitWindow }): JSX.Element {
    const pct: number = Math.max(0, Math.min(100, (props.w.count / Math.max(1, props.w.allowed)) * 100));
    return (
        <svg class={`bar ${usageTone(props.w)}`} viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
            <rect class="track" x="0" y="0" width="100" height="8" rx="4" />
            <rect class="fill" x="0" y="0" width={pct} height="8" rx="4" />
        </svg>
    );
}

/** Every window as a meter, and the limiter's current wait. */
export function LimitMeters(props: { readonly panel: LimitPanel | null }): JSX.Element {
    const now: number = useNow(500);
    const p: LimitPanel | null = props.panel;
    const waitS: number = p?.wait === null || p?.wait === undefined ? 0 : Math.max(0, (p.wait.untilMs - now) / 1000);
    if (p === null || p.policies.length === 0) {
        return <p class="muted small">No trade calls yet. Limits come from the site's own headers; the app keeps 30% headroom.</p>;
    }
    return (
        <div class="meters">
            {p.policies.map((pol: LimitPolicy) => (
                <div key={pol.policy} class="meter-group">
                    <span class="policy">{POLICY_NAMES[pol.policy] ?? pol.policy}</span>
                    {pol.windows.map((w: LimitWindow, k: number) => (
                        <div key={k} class="meter" aria-label={`${POLICY_NAMES[pol.policy] ?? pol.policy}, ${periodText(w.periodS)} window: ${w.count} of ${w.allowed}`}>
                            <span class="muted small num meter-period">{periodText(w.periodS)}</span>
                            <Bar w={w} />
                            <span class="num small meter-count">{w.count}/{w.allowed}</span>
                        </div>
                    ))}
                </div>
            ))}
            {waitS > 0 && p.wait !== null && <p class="warn small" aria-live="polite">Waiting {waitS.toFixed(1)} s · {p.wait.policy}: {p.wait.reason}</p>}
        </div>
    );
}

const GAUGE_REFRESH_MS: number = 10_000;

function refreshLimits(): void {
    void call('run.limits', {}).then((panel: LimitPanel) => {
        limits.value = panel;
    }, () => undefined);
}

/** Short windows (a few seconds to a minute) fill and empty with every call; the strip shows the longer ones. */
const STRIP_MIN_PERIOD_S: number = 120;

/**
 * A slim strip at the top of the Search and Run views: per kind of call, the longer windows as small bars
 * (they're what carries between runs), a wait when there is one, and every window one click away. It asks
 * main for fresh counts every 10 s (no network): the limiter's snapshot ages windows out.
 */
export function LimitsStrip(): JSX.Element | null {
    const now: number = useNow(1000);
    useEffect(() => {
        refreshLimits();
        const t: ReturnType<typeof setInterval> = setInterval(refreshLimits, GAUGE_REFRESH_MS);
        return () => {
            clearInterval(t);
        };
    }, []);
    const p: LimitPanel | null = limits.value;
    if (p === null || p.policies.length === 0) {
        return null;
    }
    const waitS: number = p.wait === null ? 0 : Math.max(0, (p.wait.untilMs - now) / 1000);
    return (
        <details class="limits-strip">
            <summary>
                <span class="strip-title">Trade limits</span>
                {p.policies.map((pol: LimitPolicy) => (
                    <span key={pol.policy} class="strip-policy">
                        <span class="muted">{POLICY_NAMES[pol.policy] ?? pol.policy}</span>
                        {pol.windows.filter((w: LimitWindow) => w.periodS >= STRIP_MIN_PERIOD_S).map((w: LimitWindow, k: number) => (
                            <span key={k} class="strip-window" title={`${w.count} of ${w.allowed} in ${periodText(w.periodS)}`}>
                                <span class="muted small">{periodText(w.periodS)}</span>
                                <Bar w={w} />
                                <span class="num small">{w.count}/{w.allowed}</span>
                            </span>
                        ))}
                    </span>
                ))}
                {waitS > 0 && <span class="warn small">waiting {waitS.toFixed(0)} s</span>}
                <span class="strip-more muted small">All windows</span>
            </summary>
            <div class="strip-body">
                <p class="muted small">From the site's own headers, kept up to date as windows pass. The app keeps 30% headroom on every window and waits rather than retrying into a lockout, so the short windows filling up is normal: it just paces the calls. The longer windows carry over into your next run.</p>
                <LimitMeters panel={p} />
            </div>
        </details>
    );
}
