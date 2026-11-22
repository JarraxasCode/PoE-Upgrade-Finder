// The HTTP layer, injected so the trade client and the currency client are tested on recorded responses.
// The app's signed-in transport is Electron's net.request on the isolated session partition (apps/desktop);
// GGG's public CDN uses Node's fetch (nodeFetchTransport below).
//
// Hard rule: a transport returns only the headers pickHeaders keeps (rate limits, Retry-After,
// cf-mitigated). Cookies and auth headers are never read out, so they can't reach a log.

import type { ResponseHeaders } from './rate-limiter.ts';

export type HttpMethod = 'GET' | 'POST';

export interface HttpRequest {
    readonly method: HttpMethod;
    readonly url: string;
    /** Extra request headers. Content-Type is added for a body. */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | undefined;
    readonly timeoutMs: number;
    readonly signal: AbortSignal | undefined;
}

export type HttpOutcome =
    | { readonly kind: 'response'; readonly status: number; readonly headers: ResponseHeaders; readonly text: string }
    /** A redirect is never followed (a signed-out API call can redirect to the login page). */
    | { readonly kind: 'redirect'; readonly status: number; readonly location: string }
    | { readonly kind: 'timeout' }
    | { readonly kind: 'network-error'; readonly message: string }
    | { readonly kind: 'aborted' };

export interface HttpTransport {
    send(request: HttpRequest): Promise<HttpOutcome>;
}

/** The only response headers the app keeps. */
export function keepHeader(name: string): boolean {
    const lower: string = name.toLowerCase();
    return lower.startsWith('x-rate-limit') || lower === 'retry-after' || lower === 'cf-mitigated';
}

/** Lower-cases names, joins repeated values with commas and drops every header keepHeader doesn't keep. */
export function pickHeaders(entries: Iterable<readonly [string, string | readonly string[]]>): ResponseHeaders {
    const picked: Record<string, string> = {};
    for (const [name, value] of entries) {
        if (keepHeader(name)) {
            const joined: string = typeof value === 'string' ? value : value.join(',');
            const lower: string = name.toLowerCase();
            picked[lower] = picked[lower] === undefined ? joined : `${picked[lower]},${joined}`;
        }
    }
    return picked;
}

/** Node's fetch, for GGG's public CDN (not a trade call: no session, no cookies). */
export const nodeFetchTransport: HttpTransport = {
    async send(request: HttpRequest): Promise<HttpOutcome> {
        const timeout: AbortSignal = AbortSignal.timeout(request.timeoutMs);
        const signal: AbortSignal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
        const headers: Record<string, string> = { ...request.headers };
        if (request.body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        try {
            const response: Response = await fetch(request.url, {
                method: request.method,
                headers: headers,
                body: request.body ?? null,
                redirect: 'manual',
                signal: signal,
            });
            if (response.status >= 300 && response.status < 400) {
                return { kind: 'redirect', status: response.status, location: response.headers.get('location') ?? '' };
            }
            const text: string = await response.text();
            return { kind: 'response', status: response.status, headers: pickHeaders(response.headers.entries()), text: text };
        } catch (error: unknown) {
            if (request.signal?.aborted === true) {
                return { kind: 'aborted' };
            }
            if (timeout.aborted) {
                return { kind: 'timeout' };
            }
            return { kind: 'network-error', message: error instanceof Error ? error.message : String(error) };
        }
    },
};
