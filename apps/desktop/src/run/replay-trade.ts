// A stand-in trade site for development and tests: answers searches from a recorded set of real listings
// (the V19 recording, %APPDATA%\poe-signin-spike\v19\*-raw.json; it names sellers, so it stays in app data)
// by price range and currency, and serves fetches from it. No network, no limiter. Used by the golden run
// test and by the app's --replay mode (the whole Run view on real listings, without signing in).

import { readFileSync } from 'node:fs';
import type { RunTrade } from '@poe-upgrade-finder/core';
import { readFetchResponse } from '@poe-upgrade-finder/trade';
import type { FetchResponse, SearchResponse, TradeListing, TradeSearchBody } from '@poe-upgrade-finder/trade';
import { isRecord } from '@poe-upgrade-finder/validate';

/** The divine rate when V19 was recorded (21 Nov); replayed divine prices are converted with it. */
export const V19_RATE: number = 207.9;

/** Every distinct listing in a recorded raw file's fetch responses. */
export function recordedListings(file: string): TradeListing[] {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(raw) || !Array.isArray(raw['fetch'])) {
        throw new Error(`${file} is not a recorded trade file (no fetch list)`);
    }
    const byId: Map<string, TradeListing> = new Map<string, TradeListing>();
    for (const call of raw['fetch'] as readonly unknown[]) {
        if (!isRecord(call) || !Array.isArray(call['ids'])) {
            continue;
        }
        const ids: string[] = (call['ids'] as readonly unknown[]).filter((id: unknown): id is string => typeof id === 'string');
        const fetched: FetchResponse = readFetchResponse(call['json'], ids);
        for (const l of fetched.listings) {
            byId.set(l.id, l);
        }
    }
    return [...byId.values()];
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
        const t: ReturnType<typeof setTimeout> = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
        }, { once: true });
    });
}

/** Answers a search with the recorded listings in its price range and currency, in recorded order. */
export class RecordedTrade implements RunTrade {
    public readonly bodies: TradeSearchBody[] = [];
    private readonly listings: readonly TradeListing[];
    private readonly byId: ReadonlyMap<string, TradeListing>;
    private readonly delayMs: number;

    /** delayMs: a pause before each answer, so a replayed run can be watched live. */
    public constructor(listings: readonly TradeListing[], delayMs: number = 0) {
        this.listings = listings;
        this.byId = new Map<string, TradeListing>(listings.map((l: TradeListing) => [l.id, l]));
        this.delayMs = delayMs;
    }

    public async search(_league: string, body: TradeSearchBody, signal?: AbortSignal): Promise<SearchResponse> {
        this.bodies.push(body);
        if (this.delayMs > 0) {
            await sleep(this.delayMs, signal);
        }
        const price = body.query.filters.trade_filters.filters.price;
        const matching: TradeListing[] = this.listings.filter((l: TradeListing) =>
            l.price !== undefined && l.price.currency === price.option && (price.min === undefined || l.price.amount >= price.min) && (price.max === undefined || l.price.amount <= price.max));
        return { id: `q${this.bodies.length}`, ids: matching.slice(0, 100).map((l: TradeListing) => l.id), total: matching.length, inexact: false, complexity: undefined };
    }

    public async fetch(ids: readonly string[], _queryId?: string, signal?: AbortSignal): Promise<FetchResponse> {
        if (ids.length > 10) {
            throw new RangeError(`fetch takes 1 to 10 ids, got ${ids.length}`);
        }
        if (this.delayMs > 0) {
            await sleep(this.delayMs, signal);
        }
        const listings: TradeListing[] = ids.map((id: string) => this.byId.get(id)).filter((l: TradeListing | undefined): l is TradeListing => l !== undefined);
        return { listings: listings, missing: ids.filter((id: string) => !this.byId.has(id)), malformed: [] };
    }
}
