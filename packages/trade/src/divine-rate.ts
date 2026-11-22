// The divine rate, automatically (PLAN.md, Scoring & ranking, "Prices"; Verification, V21), from GGG's
// public Currency Exchange API: hourly digests of the in-game Currency Exchange, served from a CDN.
//
//  - Ask for the last finished hour: id = floor(now / 1 h) − 1 h (unix seconds). The current hour is 404.
//  - On a 404, an empty `markets`, no Chaos|Divine market for the league or no volume, step back an hour.
//  - Rate = volume_traded[Chaos] / volume_traded[Divine] of that market. (lowest/highest_ratio can be skewed.)
//  - If nothing answers, the rate is unknown and the user types it in.
//  - Never cache a 404 (GGG's CDN marks it max-age a year): step back instead of retrying that hour.
//
// Not a trade call: no session, its own small limiter (it follows rate-limit headers if they ever appear),
// User-Agent "poe-upgrade-finder/<version>" with no contact. One reply covers every league.

import { array, isRecord, number, record, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import type { HttpOutcome, HttpTransport } from './http.ts';
import { RateLimiter } from './rate-limiter.ts';
import type { LimiterClock } from './rate-limiter.ts';
import type { TradeLogger } from './trade-client.ts';

export const GGG_EXCHANGE_URL: string = 'https://web.poecdn.com/api/currency-exchange';
export const CHAOS_ITEM: string = 'Metadata/Items/Currency/CurrencyRerollRare';
export const DIVINE_ITEM: string = 'Metadata/Items/Currency/CurrencyModValues';
const HOUR_S: number = 3600;
/** How far back to look: a few hours covers a slow digest without hammering the CDN. */
const DEFAULT_MAX_STEPS: number = 6;
const DEFAULT_REFRESH_COOLDOWN_MS: number = 30_000;
const DEFAULT_TIMEOUT_MS: number = 30_000;

export interface DivineRate {
    readonly chaosPerDivine: number;
    readonly source: 'ggg' | 'manual';
    /** The digest's hour (unix seconds, its start) for a GGG rate. */
    readonly hour: number | undefined;
    /** When it was fetched or typed in (ms). */
    readonly at: number;
}

/** Last finished hour at `nowMs`, as GGG's digest id (unix seconds). */
export function lastFinishedHour(nowMs: number): number {
    return Math.floor(nowMs / 1000 / HOUR_S) * HOUR_S - HOUR_S;
}

/** A GGG rate is out of date once a newer finished hour should exist. It's still used until that's fetched. */
export function isOutOfDate(rate: DivineRate, nowMs: number): boolean {
    return rate.source === 'ggg' && rate.hour !== undefined && lastFinishedHour(nowMs) > rate.hour;
}

export function manualRate(chaosPerDivine: number, nowMs: number): DivineRate {
    if (!(chaosPerDivine > 0) || !Number.isFinite(chaosPerDivine)) {
        throw new RangeError(`a divine rate must be a positive number, got ${chaosPerDivine}`);
    }
    return { chaosPerDivine: chaosPerDivine, source: 'manual', hour: undefined, at: nowMs };
}

export type DigestReading =
    | { readonly kind: 'rate'; readonly chaos: number; readonly divine: number; readonly chaosPerDivine: number }
    | { readonly kind: 'no-markets' }
    | { readonly kind: 'no-market'; readonly league: string }
    | { readonly kind: 'no-volume'; readonly league: string };

/** Reads one digest for one league. Only the Chaos|Divine market is validated in detail. */
export function readDigest(value: unknown, league: string): DigestReading {
    const r: JsonRecord = record(value, 'digest');
    const markets: readonly unknown[] = array(r['markets'], 'digest.markets', (m: unknown) => m);
    if (markets.length === 0) {
        return { kind: 'no-markets' };
    }
    const wanted: string = `${CHAOS_ITEM}|${DIVINE_ITEM}`;
    const reversed: string = `${DIVINE_ITEM}|${CHAOS_ITEM}`;
    const index: number = markets.findIndex((m: unknown) => isRecord(m) && m['league'] === league && (m['market_id'] === wanted || m['market_id'] === reversed));
    if (index < 0) {
        return { kind: 'no-market', league: league };
    }
    const path: string = `digest.markets[${index}]`;
    const volume: JsonRecord = record(record(markets[index], path)['volume_traded'], `${path}.volume_traded`);
    const chaos: number = number(volume[CHAOS_ITEM], `${path}.volume_traded.chaos`);
    const divine: number = number(volume[DIVINE_ITEM], `${path}.volume_traded.divine`);
    if (!(chaos > 0) || !(divine > 0)) {
        return { kind: 'no-volume', league: league };
    }
    return { kind: 'rate', chaos: chaos, divine: divine, chaosPerDivine: chaos / divine };
}

/** Where rates are kept between runs (in memory by default; the app persists it). */
export interface RateStore {
    get(league: string): DivineRate | undefined;
    set(league: string, rate: DivineRate): void;
    delete(league: string): void;
}

export class MemoryRateStore implements RateStore {
    private readonly rates: Map<string, DivineRate> = new Map<string, DivineRate>();

    public get(league: string): DivineRate | undefined {
        return this.rates.get(league);
    }

    public set(league: string, rate: DivineRate): void {
        this.rates.set(league, rate);
    }

    public delete(league: string): void {
        this.rates.delete(league);
    }
}

export interface HourAttempt {
    readonly hour: number;
    /** HTTP status, or the transport outcome when there was no response. */
    readonly status: number | 'timeout' | 'network-error' | 'redirect' | 'aborted';
    readonly result: DigestReading['kind'] | 'http-error' | 'bad-response';
}

export interface RateLookup {
    /** The rate in use: fresh, cached, or undefined when the user has to type it in. */
    readonly rate: DivineRate | undefined;
    /** True when this lookup called GGG (false: served from the store). */
    readonly fetched: boolean;
    readonly attempts: readonly HourAttempt[];
}

export interface DivineRateClientOptions {
    readonly transport: HttpTransport;
    readonly logger: TradeLogger;
    /** The app version, for the User-Agent. */
    readonly appVersion: string;
    readonly store?: RateStore;
    readonly clock?: LimiterClock;
    readonly baseUrl?: string;
    readonly maxSteps?: number;
    readonly refreshCooldownMs?: number;
    readonly timeoutMs?: number;
}

export class DivineRateClient {
    private readonly transport: HttpTransport;
    private readonly logger: TradeLogger;
    private readonly userAgent: string;
    private readonly store: RateStore;
    private readonly clock: LimiterClock | undefined;
    private readonly limiter: RateLimiter<'ggg'>;
    private readonly baseUrl: string;
    private readonly maxSteps: number;
    private readonly refreshCooldownMs: number;
    private readonly timeoutMs: number;
    private lastRefreshAt: number | undefined;

    public constructor(options: DivineRateClientOptions) {
        this.transport = options.transport;
        this.logger = options.logger;
        this.userAgent = `poe-upgrade-finder/${options.appVersion}`;
        this.store = options.store ?? new MemoryRateStore();
        this.clock = options.clock;
        this.limiter = options.clock === undefined ? new RateLimiter<'ggg'>() : new RateLimiter<'ggg'>({ clock: options.clock });
        this.baseUrl = options.baseUrl ?? GGG_EXCHANGE_URL;
        this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
        this.refreshCooldownMs = options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /**
     * The rate for a run: the stored one unless it is out of date (or missing), else GGG's newest. A manual
     * rate is always kept until the user switches back. If GGG has nothing, an out-of-date stored rate is
     * still returned (an hour-old rate is fine for band edges).
     */
    public async current(league: string, signal?: AbortSignal): Promise<RateLookup> {
        const stored: DivineRate | undefined = this.store.get(league);
        if (stored !== undefined && (stored.source === 'manual' || !isOutOfDate(stored, this.now()))) {
            return { rate: stored, fetched: false, attempts: [] };
        }
        return this.fetchLatest(league, stored, signal);
    }

    /** The Refresh button: the store unless it's out of date; at most one press per cooldown reaches GGG. */
    public async refresh(league: string, signal?: AbortSignal): Promise<RateLookup> {
        const now: number = this.now();
        const stored: DivineRate | undefined = this.store.get(league);
        const coolingDown: boolean = this.lastRefreshAt !== undefined && now - this.lastRefreshAt < this.refreshCooldownMs;
        this.lastRefreshAt = now;
        const ggg: DivineRate | undefined = stored?.source === 'ggg' ? stored : undefined;
        if (coolingDown || (ggg !== undefined && !isOutOfDate(ggg, now))) {
            return { rate: stored, fetched: false, attempts: [] };
        }
        return this.fetchLatest(league, stored, signal);
    }

    /**
     * "Use GGG rate": drops a manual rate and looks the automatic one up. If GGG has nothing, the manual rate
     * is removed anyway, so the panel (no rate) and the next run's current() agree.
     */
    public async useGgg(league: string, signal?: AbortSignal): Promise<RateLookup> {
        const stored: DivineRate | undefined = this.store.get(league);
        const lookup: RateLookup = await this.fetchLatest(league, stored?.source === 'ggg' ? stored : undefined, signal);
        if (lookup.rate === undefined && stored?.source === 'manual') {
            this.store.delete(league);
            this.logger.log('info', 'manual divine rate dropped', { league: league });
        }
        return lookup;
    }

    public setManual(league: string, chaosPerDivine: number): DivineRate {
        const rate: DivineRate = manualRate(chaosPerDivine, this.now());
        this.store.set(league, rate);
        this.logger.log('info', 'divine rate set by hand', { league: league, chaosPerDivine: chaosPerDivine });
        return rate;
    }

    private now(): number {
        return this.clock?.now() ?? Date.now();
    }

    private async fetchLatest(league: string, fallback: DivineRate | undefined, signal: AbortSignal | undefined): Promise<RateLookup> {
        const attempts: HourAttempt[] = [];
        const newest: number = lastFinishedHour(this.now());
        for (let step: number = 0; step < this.maxSteps; step++) {
            const hour: number = newest - step * HOUR_S;
            if (fallback?.hour !== undefined && hour <= fallback.hour) {
                break; // nothing newer than what we have
            }
            const { attempt, reading } = await this.tryHour(hour, league, signal);
            attempts.push(attempt);
            if (attempt.status === 'aborted') {
                break;
            }
            if (reading?.kind === 'rate') {
                const rate: DivineRate = { chaosPerDivine: reading.chaosPerDivine, source: 'ggg', hour: hour, at: this.now() };
                this.store.set(league, rate);
                this.logger.log('info', 'divine rate from GGG', { league: league, hour: hour, chaosPerDivine: rate.chaosPerDivine, chaos: reading.chaos, divine: reading.divine, steps: step + 1 });
                return { rate: rate, fetched: true, attempts: attempts };
            }
        }
        this.logger.log('warn', 'no divine rate from GGG', { league: league, attempts: attempts, keeping: fallback?.chaosPerDivine ?? null });
        return { rate: fallback, fetched: true, attempts: attempts };
    }

    private async tryHour(hour: number, league: string, signal: AbortSignal | undefined): Promise<{ readonly attempt: HourAttempt; readonly reading?: DigestReading }> {
        const url: string = `${this.baseUrl}/${hour}`;
        const started: number = this.now();
        const outcome: HttpOutcome = await this.limiter.schedule('ggg', url, async (): Promise<HttpOutcome> => {
            const sent: HttpOutcome = await this.transport.send({
                method: 'GET',
                url: url,
                headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
                body: undefined,
                timeoutMs: this.timeoutMs,
                signal: signal,
            });
            this.limiter.update('ggg', sent.kind === 'response' ? sent.headers : {}, sent.kind === 'response' ? sent.status : 0);
            return sent;
        }, signal);
        const base: Record<string, unknown> = { url: url, hour: hour, durationMs: this.now() - started };
        if (outcome.kind !== 'response') {
            this.logger.log('warn', `GET ${url} -> ${outcome.kind}`, base);
            return { attempt: { hour: hour, status: outcome.kind, result: 'http-error' } };
        }
        if (outcome.status !== 200) {
            // A 404 is the unfinished hour (or no data); never cached, we step back.
            this.logger.log(outcome.status === 404 ? 'info' : 'warn', `GET ${url} -> ${outcome.status}`, { ...base, status: outcome.status });
            return { attempt: { hour: hour, status: outcome.status, result: 'http-error' } };
        }
        let reading: DigestReading;
        try {
            reading = readDigest(JSON.parse(outcome.text), league);
        } catch (error: unknown) {
            const message: string = error instanceof ValidationError || error instanceof SyntaxError ? error.message : String(error);
            this.logger.log('error', `GET ${url} -> bad digest`, { ...base, status: 200, error: message });
            return { attempt: { hour: hour, status: 200, result: 'bad-response' } };
        }
        this.logger.log('info', `GET ${url} -> 200`, { ...base, status: 200, bytes: outcome.text.length, result: reading.kind });
        return { attempt: { hour: hour, status: 200, result: reading.kind }, reading: reading };
    }
}
