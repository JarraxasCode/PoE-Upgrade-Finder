// The one shared trade rate limiter (PLAN.md, Trade client, "Rate limiting"; ported from the spike's
// rate-limiter.js, which ran V8's 91 searches with no 429).
//
//  - one request in flight at a time, across the whole app;
//  - limits are parsed from the response headers, never hard-coded;
//  - allowed per window = max(1, floor(0.7 × limit));
//  - a local timestamped count of every request sent (errors and timeouts included), and the higher of the
//    local and server counts is used;
//  - wait rather than retry into a lockout; a wait of maxWaitMs (5 minutes) or more stops the run instead;
//  - a policy that must be paced but has no usable rules (none seen yet, a 200 without them, or a rule whose
//    limits can't be read) goes at most one request per fallbackIntervalMs, never unpaced (issue #79). A rule
//    that can't be read keeps its last good windows.
//
// Pure: the clock and sleep are injected, so it is tested with a fake clock.

/** Response headers, keys lower-cased. Only rate-limit, Retry-After and cf-mitigated headers are ever kept. */
export type ResponseHeaders = Readonly<Record<string, string>>;

/** The trade site's policies the app uses. Each has its own limits. */
/** 'data' is the site's static lists (the stat list for ModCatalog): its own rules, from its headers like the rest. */
export type TradePolicy = 'search' | 'fetch' | 'data';

export interface RateWindow {
    readonly limit: number;
    /** Window length, seconds. */
    readonly period: number;
    /** Lockout length if the window is overrun, seconds. */
    readonly restrict: number;
    /** The server's count in this window when the response was sent, if it said. */
    readonly hits: number | undefined;
    /** Seconds of an active restriction the server reports (0 when none). */
    readonly active: number;
}

export interface ParsedRateHeaders {
    readonly policy: string | undefined;
    /** Rule name (lower-cased, e.g. "account", "ip") → its windows. */
    readonly rules: Readonly<Record<string, readonly RateWindow[]>>;
    /** Rules named in X-Rate-Limit-Rules whose limit header is missing or has a part that isn't limit:period:restrict. */
    readonly malformed: readonly string[];
}

export class RateLimitStop extends Error {
    public override readonly name: string = 'RateLimitStop';
    public readonly waitMs: number;
    public readonly reason: string;

    public constructor(waitMs: number, reason: string) {
        super(`Rate limit: would have to wait ${Math.ceil(waitMs / 1000)}s (${reason}). Stopping instead.`);
        this.waitMs = waitMs;
        this.reason = reason;
    }
}

export class CancelledError extends Error {
    public override readonly name: string = 'CancelledError';

    public constructor() {
        super('Cancelled');
    }
}

export function headerValue(headers: ResponseHeaders, name: string): string | undefined {
    return headers[name.toLowerCase()];
}

/** The well-formed a:b:c parts, and whether any part (or the whole value) was missing or malformed. */
function parseTriples(value: string | undefined): { readonly triples: number[][]; readonly bad: boolean } {
    if (value === undefined || value.trim() === '') {
        return { triples: [], bad: true };
    }
    const parts: number[][] = value.split(',').map((part: string) =>
        part
            .trim()
            .split(':')
            .map((n: string) => (n.trim() === '' ? Number.NaN : Number(n))),
    );
    const triples: number[][] = parts.filter((triple: number[]) => triple.length === 3 && triple.every((n: number) => Number.isFinite(n)));
    return { triples: triples, bad: triples.length !== parts.length };
}

/** Parses X-Rate-Limit-Rules and each X-Rate-Limit-<rule>[-State] header. Undefined when there are no rules. */
export function parseRateHeaders(headers: ResponseHeaders): ParsedRateHeaders | undefined {
    const rulesValue: string | undefined = headerValue(headers, 'x-rate-limit-rules');
    if (rulesValue === undefined) {
        return undefined;
    }
    const rules: Record<string, readonly RateWindow[]> = {};
    const malformed: string[] = [];
    const ruleNames: string[] = rulesValue
        .split(',')
        .map((name: string) => name.trim().toLowerCase())
        .filter((name: string) => name.length > 0);
    for (const ruleName of ruleNames) {
        const parsedLimits: { readonly triples: number[][]; readonly bad: boolean } = parseTriples(
            headerValue(headers, `x-rate-limit-${ruleName}`),
        );
        // A window of 0 requests or 0 seconds can't pace anything: as malformed as a garbled one.
        const limits: number[][] = parsedLimits.triples.filter((t: number[]) => (t[0] ?? 0) > 0 && (t[1] ?? 0) > 0);
        if (parsedLimits.bad || limits.length !== parsedLimits.triples.length) {
            malformed.push(ruleName);
        }
        const states: number[][] = parseTriples(headerValue(headers, `x-rate-limit-${ruleName}-state`)).triples;
        rules[ruleName] = limits.map((triple: number[], index: number): RateWindow => {
            const [limit = 0, period = 0, restrict = 0] = triple;
            const state: number[] | undefined = states.find((s: number[]) => s[1] === period) ?? states[index];
            return { limit: limit, period: period, restrict: restrict, hits: state?.[0], active: state?.[2] ?? 0 };
        });
    }
    return { policy: headerValue(headers, 'x-rate-limit-policy'), rules: rules, malformed: malformed };
}

export type LimiterEvent<K extends string> =
    | { readonly kind: 'send'; readonly key: K; readonly label: string; readonly at: number }
    | { readonly kind: 'wait'; readonly key: K; readonly label: string; readonly waitMs: number; readonly reason: string }
    | { readonly kind: 'stop'; readonly key: K; readonly label: string; readonly waitMs: number; readonly reason: string }
    | { readonly kind: 'retry-after'; readonly key: K; readonly seconds: number }
    /** A response had no rate-limit rules we can use, or a rule we can't read (issue #79). */
    | { readonly kind: 'unusable'; readonly key: K; readonly reason: string }
    /** A response's headers were read: the counts changed (the UI's rate-limit gauge redraws). */
    | { readonly kind: 'observed'; readonly key: K };

export interface LimiterClock {
    now(): number;
    sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
}

export interface RateLimiterOptions<K extends string> {
    readonly clock?: LimiterClock;
    /** Share of each limit we allow ourselves. Default 0.7. */
    readonly headroom?: number;
    /** A wait this long or longer stops instead. Default 5 minutes. */
    readonly maxWaitMs?: number;
    readonly onEvent?: (event: LimiterEvent<K>) => void;
    /** Policies that must never go unpaced: with no usable rules they get one request per fallbackIntervalMs. */
    readonly pacedWithoutRules?: readonly K[];
    /** Default 10 s. */
    readonly fallbackIntervalMs?: number;
}

export interface WaitDecision {
    readonly waitMs: number;
    readonly reason: string | undefined;
}

export interface WindowSnapshot {
    readonly rule: string;
    /** The higher of our count and the server's. */
    readonly count: number;
    readonly local: number;
    readonly server: number;
    readonly allowed: number;
    readonly limit: number;
    readonly period: number;
    readonly restrict: number;
}

export interface PolicySnapshot {
    readonly policy: string | undefined;
    readonly windows: readonly WindowSnapshot[];
}

interface PolicyState {
    readonly parsed: ParsedRateHeaders;
    readonly observedAt: number;
    /** False when a named rule has no windows to pace by. */
    readonly usable: boolean;
}

const DEFAULT_RETRY_AFTER_SECONDS: number = 60;
const DEFAULT_FALLBACK_INTERVAL_MS: number = 10_000;
/** How long sent times are kept when no policy has been seen yet (the longest window seen on 21 Nov). */
const DEFAULT_KEEP_SECONDS: number = 3 * 3600;

export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
        if (signal?.aborted === true) {
            reject(new CancelledError());
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new CancelledError());
        };
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export const systemClock: LimiterClock = {
    now(): number {
        return Date.now();
    },
    sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
        return abortableSleep(ms, signal);
    },
};

export class RateLimiter<K extends string = TradePolicy> {
    private readonly clock: LimiterClock;
    private readonly headroom: number;
    private readonly maxWaitMs: number;
    private readonly onEvent: (event: LimiterEvent<K>) => void;
    private readonly pacedWithoutRules: ReadonlySet<K>;
    private readonly fallbackIntervalMs: number;
    private readonly policies: Map<K, PolicyState> = new Map<K, PolicyState>();
    private readonly sent: Map<K, number[]> = new Map<K, number[]>();
    private readonly blockedUntil: Map<K, number> = new Map<K, number>();
    private queue: Promise<unknown> = Promise.resolve();

    public constructor(options: RateLimiterOptions<K> = {}) {
        this.clock = options.clock ?? systemClock;
        this.headroom = options.headroom ?? 0.7;
        this.maxWaitMs = options.maxWaitMs ?? 300_000;
        this.onEvent = options.onEvent ?? ((): void => undefined);
        this.pacedWithoutRules = new Set<K>(options.pacedWithoutRules ?? []);
        this.fallbackIntervalMs = options.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS;
    }

    public allowedFor(limit: number): number {
        return Math.max(1, Math.floor(this.headroom * limit));
    }

    /** Runs task() once a slot is free. Tasks run strictly one at a time, in call order. */
    public schedule<T>(key: K, label: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const run = async (): Promise<T> => {
            await this.waitForSlot(key, label, signal);
            this.markSent(key, label);
            return task();
        };
        const result: Promise<T> = this.queue.then(run, run);
        this.queue = result.catch((): undefined => undefined);
        return result;
    }

    /** Records what a response said about the limits. Call it for every response, errors included. */
    public update(key: K, headers: ResponseHeaders, status: number): ParsedRateHeaders | undefined {
        const now: number = this.clock.now();
        const parsed: ParsedRateHeaders | undefined = parseRateHeaders(headers);
        if (parsed !== undefined) {
            this.policies.set(key, this.withLastGood(key, parsed, now));
            this.onEvent({ kind: 'observed', key: key });
        } else if (status === 200 && this.pacedWithoutRules.has(key)) {
            // The limits we knew still hold; with none known, computeWait paces by the fallback interval.
            this.onEvent({ kind: 'unusable', key: key, reason: 'a 200 with no X-Rate-Limit-Rules header' });
        }
        if (status === 429) {
            const retryAfter: number = Number(headerValue(headers, 'retry-after'));
            const seconds: number = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS;
            this.blockedUntil.set(key, now + seconds * 1000);
            this.onEvent({ kind: 'retry-after', key: key, seconds: seconds });
        }
        return parsed;
    }

    public computeWait(key: K): WaitDecision {
        const now: number = this.clock.now();
        let waitMs: number = 0;
        let reason: string | undefined;
        const blocked: number = this.blockedUntil.get(key) ?? 0;
        if (blocked > now) {
            waitMs = blocked - now;
            reason = 'Retry-After from a 429';
        }
        const state: PolicyState | undefined = this.policies.get(key);
        const times: readonly number[] = this.sent.get(key) ?? [];
        if ((state === undefined || !state.usable) && this.pacedWithoutRules.has(key)) {
            // No usable rules: the first request goes alone and teaches us the limits; until then, one per interval.
            const last: number | undefined = times[times.length - 1];
            const intervalWait: number = last === undefined ? 0 : last + this.fallbackIntervalMs - now;
            if (intervalWait > waitMs) {
                waitMs = intervalWait;
                reason = `no usable rate-limit rules yet: one request per ${this.fallbackIntervalMs / 1000}s`;
            }
        }
        if (state === undefined) {
            // Unknown policy: its first request goes alone (requests are serialised anyway) and teaches us the limits.
            return { waitMs: waitMs, reason: reason };
        }
        for (const [ruleName, windows] of Object.entries(state.parsed.rules)) {
            for (const w of windows) {
                const periodMs: number = w.period * 1000;
                if (w.active > 0) {
                    const until: number = state.observedAt + w.active * 1000;
                    if (until > now && until - now > waitMs) {
                        waitMs = until - now;
                        reason = `${ruleName} ${w.limit}:${w.period}s is restricting (server says ${w.active}s)`;
                    }
                }
                const allowed: number = this.allowedFor(w.limit);
                const local: number[] = times.filter((t: number) => t > now - periodMs);
                let windowWait: number = 0;
                const oldestCounted: number | undefined = local[local.length - allowed];
                if (local.length >= allowed && oldestCounted !== undefined) {
                    windowWait = oldestCounted + periodMs - now;
                }
                // The server's count, when it is still current. Its hits are ours (sent times we know) plus any we
                // don't know about (the user's browser on the site, a buy link): those are placed at the latest time
                // they can have happened, the response we read it from, so they age out no sooner than they really
                // do. The wait is until enough of the merged hits leave the window. (It used to wait a whole period
                // from the response whenever the server said full: 300 s stalls where 60 to 90 s were enough, 22 Nov.)
                const serverValid: boolean = w.hits !== undefined && now < state.observedAt + periodMs;
                if (serverValid && (w.hits ?? 0) >= allowed) {
                    const knownAtObservation: number = times.filter(
                        (t: number) => t > state.observedAt - periodMs && t <= state.observedAt,
                    ).length;
                    const unknown: number = Math.max(0, (w.hits ?? 0) - knownAtObservation);
                    const merged: number[] = [...local, ...new Array<number>(unknown).fill(state.observedAt)].sort(
                        (a: number, b: number) => a - b,
                    );
                    const freeing: number | undefined = merged[merged.length - allowed];
                    if (merged.length >= allowed && freeing !== undefined) {
                        windowWait = Math.max(windowWait, freeing + periodMs - now);
                    }
                }
                if (windowWait > waitMs) {
                    waitMs = windowWait;
                    reason = `${ruleName} window ${w.limit} per ${w.period}s (we allow ${allowed})`;
                }
            }
        }
        return { waitMs: waitMs, reason: reason };
    }

    /** For display: each window as "count of allowed per period". */
    public snapshot(): ReadonlyMap<K, PolicySnapshot> {
        const now: number = this.clock.now();
        const out: Map<K, PolicySnapshot> = new Map<K, PolicySnapshot>();
        for (const [key, state] of this.policies.entries()) {
            const times: readonly number[] = this.sent.get(key) ?? [];
            const windows: WindowSnapshot[] = [];
            for (const [ruleName, ruleWindows] of Object.entries(state.parsed.rules)) {
                for (const w of ruleWindows) {
                    const periodMs: number = w.period * 1000;
                    const local: number = times.filter((t: number) => t > now - periodMs).length;
                    const server: number = w.hits !== undefined && now < state.observedAt + periodMs ? w.hits : 0;
                    windows.push({
                        rule: ruleName,
                        count: Math.max(local, server),
                        local: local,
                        server: server,
                        allowed: this.allowedFor(w.limit),
                        limit: w.limit,
                        period: w.period,
                        restrict: w.restrict,
                    });
                }
            }
            out.set(key, { policy: state.parsed.policy, windows: windows });
        }
        return out;
    }

    /** A rule we can't read keeps its last good windows (without their stale counts), and says so. */
    private withLastGood(key: K, parsed: ParsedRateHeaders, now: number): PolicyState {
        const anyWindows = (rules: Readonly<Record<string, readonly RateWindow[]>>): boolean =>
            Object.values(rules).some((w: readonly RateWindow[]) => w.length > 0);
        if (parsed.malformed.length === 0) {
            return { parsed: parsed, observedAt: now, usable: anyWindows(parsed.rules) };
        }
        const previous: PolicyState | undefined = this.policies.get(key);
        const rules: Record<string, readonly RateWindow[]> = { ...parsed.rules };
        let usable: boolean = true;
        for (const name of parsed.malformed) {
            const last: readonly RateWindow[] = previous?.parsed.rules[name] ?? [];
            if (last.length > 0) {
                rules[name] = last.map((w: RateWindow) => ({ ...w, hits: undefined, active: 0 }));
            } else {
                usable = false;
            }
            this.onEvent({
                kind: 'unusable',
                key: key,
                reason: `the ${name} rule's limits can't be read${last.length === 0 ? '' : '; keeping its last good windows'}`,
            });
        }
        return { parsed: { ...parsed, rules: rules }, observedAt: now, usable: usable && anyWindows(rules) };
    }

    private markSent(key: K, label: string): void {
        const now: number = this.clock.now();
        let times: number[] | undefined = this.sent.get(key);
        if (times === undefined) {
            times = [];
            this.sent.set(key, times);
        }
        times.push(now);
        const keepMs: number = this.longestPeriodMs(key);
        while (times.length > 0 && (times[0] ?? now) <= now - keepMs) {
            times.shift();
        }
        this.onEvent({ kind: 'send', key: key, label: label, at: now });
    }

    private longestPeriodMs(key: K): number {
        let longest: number = DEFAULT_KEEP_SECONDS;
        const state: PolicyState | undefined = this.policies.get(key);
        if (state !== undefined) {
            for (const windows of Object.values(state.parsed.rules)) {
                for (const w of windows) {
                    longest = Math.max(longest, w.period);
                }
            }
        }
        return longest * 1000;
    }

    private async waitForSlot(key: K, label: string, signal: AbortSignal | undefined): Promise<void> {
        for (;;) {
            if (signal?.aborted === true) {
                throw new CancelledError();
            }
            const decision: WaitDecision = this.computeWait(key);
            if (decision.waitMs <= 0) {
                return;
            }
            const reason: string = decision.reason ?? 'rate limit';
            if (decision.waitMs >= this.maxWaitMs) {
                this.onEvent({ kind: 'stop', key: key, label: label, waitMs: decision.waitMs, reason: reason });
                throw new RateLimitStop(decision.waitMs, reason);
            }
            this.onEvent({ kind: 'wait', key: key, label: label, waitMs: decision.waitMs, reason: reason });
            await this.clock.sleep(decision.waitMs, signal);
        }
    }
}
