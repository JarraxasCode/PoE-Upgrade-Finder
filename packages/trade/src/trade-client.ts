// The only code that calls pathofexile.com's trade API (PLAN.md, Trade client). Every call goes through the
// one shared RateLimiter. Only the rate-limit, Retry-After and cf-mitigated headers are ever read; cookies
// and auth headers never reach this code.
//
// Retries: a 5xx, a timeout or a network error gets one retry, through the limiter. A 429 gets one retry
// too: the limiter has recorded its Retry-After, so the retry waits it out, or stops the run with
// RateLimitStop when the wait is 5 minutes or more.

import { ValidationError } from '@poe-upgrade-finder/validate';
import type { HttpMethod, HttpOutcome, HttpTransport } from './http.ts';
import { readFetchResponse, readSearchResponse, readSiteError } from './listing.ts';
import type { FetchResponse, SearchResponse } from './listing.ts';
import type { TradeSearchBody } from './query.ts';
import { CancelledError, parseRateHeaders } from './rate-limiter.ts';
import { readStatList } from './stat-list.ts';
import type { TradeStatEntry } from './stat-list.ts';
import type { ParsedRateHeaders, RateLimiter, ResponseHeaders, TradePolicy } from './rate-limiter.ts';

export const POE_ORIGIN: string = 'https://www.pathofexile.com';
export const MAX_FETCH_IDS: number = 10;
const DEFAULT_TIMEOUT_MS: number = 30_000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structurally the same as the engine client's logger; packages/logging implements it. */
export interface TradeLogger {
    log(level: LogLevel, message: string, data?: Readonly<Record<string, unknown>>): void;
}

export type TradeErrorCode =
    /** Cloudflare challenged the request (cf-mitigated): sign in again in the app window. */
    | 'cloudflare'
    /** The response's rate-limit rules have no Account rule: the session is gone. */
    | 'signed-out'
    /** A redirect (the site sends signed-out API calls to the login page). */
    | 'redirect'
    /** The site answered with its own error body, e.g. code 2 "Query is too complex". */
    | 'site-error'
    | 'http'
    | 'timeout'
    | 'network'
    /** The response wasn't the JSON we expect. */
    | 'bad-response';

export class TradeError extends Error {
    public override readonly name: string = 'TradeError';
    public readonly code: TradeErrorCode;
    public readonly status: number | undefined;
    public readonly siteCode: number | undefined;

    public constructor(code: TradeErrorCode, message: string, status?: number, siteCode?: number) {
        super(message);
        this.code = code;
        this.status = status;
        this.siteCode = siteCode;
    }
}

/** One response as the client saw it, for recording fixtures (the JSON is the parsed body, tokens included). */
export interface RecordedResponse {
    readonly policy: TradePolicy;
    readonly method: HttpMethod;
    readonly path: string;
    readonly status: number;
    readonly json: unknown;
}

export interface TradeClientOptions {
    readonly transport: HttpTransport;
    readonly limiter: RateLimiter<TradePolicy>;
    readonly logger: TradeLogger;
    readonly origin?: string;
    readonly timeoutMs?: number;
    readonly now?: () => number;
    /** Called with every response that had a body. */
    readonly onResponse?: (response: RecordedResponse) => void;
}

interface CallSpec<T> {
    readonly policy: TradePolicy;
    readonly method: HttpMethod;
    readonly path: string;
    readonly body: unknown;
    readonly signal: AbortSignal | undefined;
    readonly read: (json: unknown) => T;
    /** Extra fields for the log line on success. */
    readonly summary: (value: T) => Readonly<Record<string, unknown>>;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export class TradeClient {
    private readonly transport: HttpTransport;
    private readonly limiter: RateLimiter<TradePolicy>;
    private readonly logger: TradeLogger;
    private readonly origin: string;
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly onResponse: ((response: RecordedResponse) => void) | undefined;
    private seq: number = 0;
    private signedInState: boolean | undefined;

    public constructor(options: TradeClientOptions) {
        this.transport = options.transport;
        this.limiter = options.limiter;
        this.logger = options.logger;
        this.origin = options.origin ?? POE_ORIGIN;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
        this.onResponse = options.onResponse;
    }

    /** What the last response's rate-limit rules said: true with an Account rule, false without, undefined before any. */
    public get signedIn(): boolean | undefined {
        return this.signedInState;
    }

    public search(league: string, body: TradeSearchBody, signal?: AbortSignal): Promise<SearchResponse> {
        return this.call({
            policy: 'search',
            method: 'POST',
            path: `/api/trade/search/${encodeURIComponent(league)}`,
            body: body,
            signal: signal,
            read: readSearchResponse,
            summary: (r: SearchResponse) => ({ searchId: r.id, total: r.total, ids: r.ids.length, complexity: r.complexity ?? null }),
        });
    }

    /** Fetches up to 10 listings. queryId is optional (V16: ids from several searches can be mixed). */
    public fetch(ids: readonly string[], queryId?: string, signal?: AbortSignal): Promise<FetchResponse> {
        if (ids.length === 0 || ids.length > MAX_FETCH_IDS) {
            throw new RangeError(`fetch takes 1 to ${MAX_FETCH_IDS} ids, got ${ids.length}`);
        }
        const query: string = queryId === undefined ? '' : `?query=${encodeURIComponent(queryId)}`;
        return this.call({
            policy: 'fetch',
            method: 'GET',
            path: `/api/trade/fetch/${ids.map((id: string) => encodeURIComponent(id)).join(',')}${query}`,
            body: undefined,
            signal: signal,
            read: (json: unknown) => readFetchResponse(json, ids),
            summary: (r: FetchResponse) => ({ returned: r.listings.length, missing: r.missing.length, malformed: r.malformed }),
        });
    }

    /** The site's stat list (every searchable stat id with its text), for ModCatalog. Cached by the app for days. */
    public stats(signal?: AbortSignal): Promise<TradeStatEntry[]> {
        return this.call({
            policy: 'data',
            method: 'GET',
            path: '/api/trade/data/stats',
            body: undefined,
            signal: signal,
            read: readStatList,
            summary: (r: TradeStatEntry[]) => ({ entries: r.length }),
        });
    }

    /**
     * The site's bulk exchange. Not used for the divine rate (V13: it is a different market from the in-game
     * Currency Exchange); kept because it shares the limiter and the spike exercised it.
     */
    public exchange(league: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
        return this.call({
            policy: 'exchange',
            method: 'POST',
            path: `/api/trade/exchange/${encodeURIComponent(league)}`,
            body: body,
            signal: signal,
            read: (json: unknown) => json,
            summary: () => ({}),
        });
    }

    private async call<T>(spec: CallSpec<T>): Promise<T> {
        const reqId: number = ++this.seq;
        const bodyText: string | undefined = spec.body === undefined ? undefined : JSON.stringify(spec.body);
        let lastError: TradeError | undefined;
        for (let attempt: number = 1; attempt <= 2; attempt++) {
            const started: number = this.now();
            const outcome: HttpOutcome = await this.limiter.schedule(
                spec.policy,
                spec.path,
                async (): Promise<HttpOutcome> => {
                    const sent: HttpOutcome = await this.transport.send({
                        method: spec.method,
                        url: this.origin + spec.path,
                        headers: { Accept: 'application/json' },
                        body: bodyText,
                        timeoutMs: this.timeoutMs,
                        signal: spec.signal,
                    });
                    this.limiter.update(
                        spec.policy,
                        sent.kind === 'response' ? sent.headers : {},
                        sent.kind === 'response' ? sent.status : 0,
                    );
                    return sent;
                },
                spec.signal,
            );
            const base: Record<string, unknown> = {
                reqId: reqId,
                policy: spec.policy,
                method: spec.method,
                path: spec.path,
                body: spec.body ?? null,
                attempt: attempt,
                durationMs: this.now() - started,
            };
            if (outcome.kind === 'aborted') {
                this.logger.log('info', `${spec.method} ${spec.path} cancelled`, base);
                throw new CancelledError();
            }
            if (outcome.kind !== 'response') {
                const code: TradeErrorCode = outcome.kind === 'redirect' ? 'redirect' : outcome.kind === 'timeout' ? 'timeout' : 'network';
                const message: string =
                    outcome.kind === 'redirect'
                        ? `redirected to ${new URL(outcome.location, this.origin).pathname}`
                        : outcome.kind === 'timeout'
                          ? 'timed out'
                          : outcome.message;
                this.logger.log('warn', `${spec.method} ${spec.path} -> ${code}`, {
                    ...base,
                    error: message,
                    status: outcome.kind === 'redirect' ? outcome.status : null,
                });
                lastError = new TradeError(code, `${spec.policy}: ${message}`, outcome.kind === 'redirect' ? outcome.status : undefined);
                if (code === 'redirect') {
                    throw lastError;
                }
                continue;
            }
            const result: T | TradeError | 'retry' = this.handleResponse(spec, outcome, base, attempt);
            if (result === 'retry') {
                continue;
            }
            if (result instanceof TradeError) {
                throw result;
            }
            return result;
        }
        throw lastError ?? new TradeError('http', `${spec.policy}: failed after retry`);
    }

    private handleResponse<T>(
        spec: CallSpec<T>,
        outcome: { readonly status: number; readonly headers: ResponseHeaders; readonly text: string },
        base: Readonly<Record<string, unknown>>,
        attempt: number,
    ): T | TradeError | 'retry' {
        const rate: ParsedRateHeaders | undefined = parseRateHeaders(outcome.headers);
        const cloudflare: boolean = outcome.headers['cf-mitigated'] !== undefined;
        if (rate !== undefined) {
            this.signedInState = Object.prototype.hasOwnProperty.call(rate.rules, 'account');
        }
        const json: unknown = parseJson(outcome.text);
        if (json !== undefined) {
            this.onResponse?.({ policy: spec.policy, method: spec.method, path: spec.path, status: outcome.status, json: json });
        }
        const siteError: { readonly code: number | undefined; readonly message: string } | undefined = readSiteError(json);
        const data: Record<string, unknown> = {
            ...base,
            status: outcome.status,
            rateHeaders: outcome.headers,
            error: siteError?.message ?? (outcome.status === 200 ? null : outcome.text.slice(0, 160)),
            errorCode: siteError?.code ?? null,
        };
        if (cloudflare) {
            this.logger.log('warn', `${spec.method} ${spec.path} -> Cloudflare challenge`, data);
            return new TradeError('cloudflare', 'Cloudflare challenged the request. Sign in again in the app window.', outcome.status);
        }
        if (rate !== undefined && this.signedInState === false) {
            this.logger.log('warn', `${spec.method} ${spec.path} -> signed out`, data);
            return new TradeError(
                'signed-out',
                'Not signed in ("Account" is missing from the rate-limit rules). Sign in again in the app window.',
                outcome.status,
            );
        }
        if (outcome.status === 200 && siteError === undefined) {
            try {
                const value: T = spec.read(json);
                this.logger.log('info', `${spec.method} ${spec.path} -> 200`, { ...data, ...spec.summary(value) });
                return value;
            } catch (error: unknown) {
                const message: string = error instanceof ValidationError ? error.message : String(error);
                this.logger.log('error', `${spec.method} ${spec.path} -> bad response`, { ...data, error: message });
                return new TradeError('bad-response', `${spec.policy}: unexpected response (${message})`, outcome.status);
            }
        }
        const retryable: boolean = outcome.status === 429 || outcome.status >= 500;
        this.logger.log('warn', `${spec.method} ${spec.path} -> ${outcome.status}`, data);
        if (retryable && attempt === 1) {
            return 'retry';
        }
        if (siteError !== undefined) {
            return new TradeError('site-error', `${spec.policy}: ${siteError.message}`, outcome.status, siteError.code);
        }
        return new TradeError('http', `${spec.policy}: HTTP ${outcome.status}`, outcome.status);
    }
}
