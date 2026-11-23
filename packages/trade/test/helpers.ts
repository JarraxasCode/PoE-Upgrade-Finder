// Test helpers: a fake clock, a scripted transport, and the rate-limit header strings recorded signed in on
// 21 Nov (spike logs; PLAN.md, Rate limiting).

import type { HttpOutcome, HttpRequest, HttpTransport } from '../src/http.ts';
import type { LimiterClock, ResponseHeaders } from '../src/rate-limiter.ts';

export class FakeClock implements LimiterClock {
    public t: number = 1_000_000;
    public readonly slept: number[] = [];

    public now(): number {
        return this.t;
    }

    public sleep(ms: number): Promise<void> {
        this.slept.push(ms);
        this.t += ms;
        return Promise.resolve();
    }
}

export function searchHeaders(accountHits: number, ipHits: number, extra: Readonly<Record<string, string>> = {}): ResponseHeaders {
    return {
        'x-rate-limit-policy': 'trade-search-request-limit',
        'x-rate-limit-rules': 'Account,Ip',
        'x-rate-limit-account': '3:5:60',
        'x-rate-limit-account-state': `${accountHits}:5:0`,
        'x-rate-limit-ip': '8:10:60,15:60:120,60:300:1800,600:10800:3600',
        'x-rate-limit-ip-state': `${ipHits}:10:0,${ipHits}:60:0,${ipHits}:300:0,${ipHits}:10800:0`,
        ...extra,
    };
}

export function fetchHeaders(hits: number): ResponseHeaders {
    return {
        'x-rate-limit-policy': 'trade-fetch-request-limit',
        'x-rate-limit-rules': 'Account,Ip',
        'x-rate-limit-account': '6:4:10',
        'x-rate-limit-account-state': `${hits}:4:0`,
        'x-rate-limit-ip': '12:4:60,16:12:60,100:300:300,1000:10800:1800',
        'x-rate-limit-ip-state': `${hits}:4:0,${hits}:12:0,${hits}:300:0,${hits}:10800:0`,
    };
}

/** Signed out: the same search policy with only the Ip rule (signed-out limits). */
export function signedOutSearchHeaders(): ResponseHeaders {
    return {
        'x-rate-limit-policy': 'trade-search-request-limit',
        'x-rate-limit-rules': 'Ip',
        'x-rate-limit-ip': '5:10:60,15:60:300,30:300:1800,600:21600:3600',
        'x-rate-limit-ip-state': '1:10:0,1:60:0,1:300:0,1:21600:0',
    };
}

export function response(status: number, headers: ResponseHeaders, json: unknown): HttpOutcome {
    return { kind: 'response', status: status, headers: headers, text: JSON.stringify(json) };
}

/** Answers each request with the next scripted outcome (or a function of the request). */
export class ScriptedTransport implements HttpTransport {
    public readonly requests: HttpRequest[] = [];
    private readonly script: ((request: HttpRequest) => HttpOutcome)[];

    public constructor(script: readonly (HttpOutcome | ((request: HttpRequest) => HttpOutcome))[]) {
        this.script = script.map((s: HttpOutcome | ((request: HttpRequest) => HttpOutcome)) =>
            typeof s === 'function' ? s : (): HttpOutcome => s,
        );
    }

    public send(request: HttpRequest): Promise<HttpOutcome> {
        this.requests.push(request);
        const next: ((request: HttpRequest) => HttpOutcome) | undefined = this.script.shift();
        if (next === undefined) {
            throw new Error(`unexpected request ${request.method} ${request.url}`);
        }
        return Promise.resolve(next(request));
    }
}

/** A rare item's text as the trade site encodes it: CRLF lines and a trailing Note section. */
export function encodedItemText(note: string = '~b/o 115 chaos'): string {
    const lines: readonly string[] = [
        'Item Class: Boots',
        'Rarity: Rare',
        'Gloom Spark',
        'Sorcerer Boots',
        '--------',
        'Energy Shield: 70',
        '--------',
        'Item Level: 84',
        '--------',
        '+70 to maximum Life',
        '+35% to Chaos Resistance',
        '25% increased Movement Speed',
        '--------',
        `Note: ${note}`,
        '',
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64');
}

export function listingJson(id: string, amount: number, currency: string, seller: string = 'SellerA'): unknown {
    return {
        id: id,
        listing: {
            method: 'psapi',
            indexed: '2026-11-21T10:00:00Z',
            price: { type: '~b/o', amount: amount, currency: currency },
            account: { name: seller, online: null },
            whisper_token: 'secret',
        },
        item: {
            name: 'Gloom Spark',
            typeLine: 'Sorcerer Boots',
            baseType: 'Sorcerer Boots',
            rarity: 'Rare',
            ilvl: 84,
            identified: true,
            extended: {
                text: encodedItemText(),
                hashes: {
                    explicit: [
                        ['explicit.stat_3299347043', [0]],
                        ['explicit.stat_2923486259', [1]],
                    ],
                    implicit: [['implicit.stat_1', [0]]],
                    crafted: [['crafted.stat_2250533757', [0]]],
                },
            },
        },
    };
}
