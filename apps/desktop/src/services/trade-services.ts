// The app's one trade client and its one shared rate limiter (Hard rules: every trade call goes through it),
// the sign-in state (D10, from a trade call's rules, never the cookie) and the divine rate (V21, GGG's
// Currency Exchange API; a manual override is always possible).

import { session } from 'electron';
import type { Session } from 'electron';
import type { RateInfo, RateState, SignInState } from '@poe-upgrade-finder/ipc';
import type { JsonlLogger, Logger } from '@poe-upgrade-finder/logging';
import { ModCatalog } from '@poe-upgrade-finder/core';
import { DivineRateClient, nodeFetchTransport, RateLimiter, TradeClient } from '@poe-upgrade-finder/trade';
import type {
    DivineRate,
    LimiterEvent,
    RateLookup,
    RateStore,
    RecordedResponse,
    TradePolicy,
    TradeStatEntry,
} from '@poe-upgrade-finder/trade';
import { electronTransport } from '../electron-transport.ts';
import { openSignInWindow, probeSignIn, TRADE_PARTITION } from '../signin.ts';
import { postLogout } from '../signout.ts';
import type { LogoutOutcome } from '../signout.ts';
import type { SignInState as ProbeState } from '../signin.ts';
import { messageOf } from '@poe-upgrade-finder/validate';

export interface TradeServicesOptions {
    readonly userData: string;
    readonly appVersion: string;
    readonly logger: JsonlLogger;
    readonly league: () => string;
    readonly onSignIn: (state: SignInState) => void;
    readonly onRate: (state: RateState) => void;
    /** Where the last divine rate per league is kept (the cache file). */
    readonly rateStore: RateStore;
    /** The cached trade stat list (ModCatalog), read and written through the cache file. */
    readonly statCache: StatListCache;
    /** Development (--record-trade): every trade response, for a recording. */
    readonly onResponse?: (response: RecordedResponse) => void;
}

export interface StatListCache {
    statList(): { readonly entries: TradeStatEntry[]; readonly fetchedAt: number } | undefined;
    saveStatList(entries: readonly TradeStatEntry[], fetchedAt: number): void;
}

/** The stat list is refetched after this long (new leagues add stats; within a league it barely changes). */
export const STAT_LIST_MAX_AGE_MS: number = 7 * 24 * 3600 * 1000;

export function rateInfo(rate: DivineRate): RateInfo {
    return {
        chaosPerDivine: rate.chaosPerDivine,
        source: rate.source,
        hourMs: rate.hour === undefined ? null : rate.hour * 1000,
        atMs: rate.at,
    };
}

export class TradeServices {
    public readonly limiter: RateLimiter<TradePolicy>;
    public readonly client: TradeClient;
    private readonly options: TradeServicesOptions;
    private readonly rates: DivineRateClient;
    private readonly limiterListeners: Set<(event: LimiterEvent<TradePolicy>) => void> = new Set();
    private signIn: SignInState = { status: 'unknown', message: null, checkedAtMs: null };
    private modCatalog: ModCatalog | undefined = undefined;
    private checking: Promise<SignInState> | undefined = undefined;
    private windowOpen: boolean = false;
    private rate: RateState;

    public constructor(options: TradeServicesOptions) {
        this.options = options;
        const rateLog: Logger = options.logger.area('rate');
        this.limiter = new RateLimiter<TradePolicy>({
            // 'data' (the static lists) answers with no rate headers; the rest must never go unpaced (#79).
            pacedWithoutRules: ['search', 'fetch'],
            onEvent: (event: LimiterEvent<TradePolicy>): void => {
                if (event.kind === 'send') {
                    rateLog.log('debug', `send ${event.key}`, { label: event.label });
                } else if (event.kind === 'wait') {
                    rateLog.log('info', `wait ${Math.round(event.waitMs)}ms`, { key: event.key, reason: event.reason });
                } else if (event.kind === 'stop') {
                    rateLog.log('warn', 'stop', { key: event.key, waitMs: event.waitMs, reason: event.reason });
                } else if (event.kind === 'retry-after') {
                    rateLog.log('warn', `429, Retry-After ${event.seconds}s`, { key: event.key });
                } else if (event.kind === 'unusable') {
                    rateLog.log('warn', 'rate-limit headers not usable', { key: event.key, reason: event.reason });
                }
                for (const listener of this.limiterListeners) {
                    listener(event);
                }
            },
        });
        const tradeSession = session.fromPartition(TRADE_PARTITION);
        // Electron's default user agent, unchanged (Hard rules); logged because Cloudflare reacts to it (V15).
        options.logger.area('signin').log('info', 'trade session', { partition: TRADE_PARTITION, userAgent: tradeSession.getUserAgent() });
        this.client = new TradeClient({
            transport: electronTransport(tradeSession),
            limiter: this.limiter,
            logger: options.logger.area('trade'),
            ...(options.onResponse === undefined ? {} : { onResponse: options.onResponse }),
        });
        this.rates = new DivineRateClient({
            transport: nodeFetchTransport,
            logger: rateLog,
            appVersion: options.appVersion,
            store: options.rateStore,
        });
        this.rate = { league: options.league(), rate: null, busy: false, error: null, refreshBlockedUntilMs: null };
    }

    /**
     * The ModCatalog: from memory, else the cache file (under a week old), else one call to the site's stat list
     * (its own 'data' rules, through the shared limiter). A failed fetch falls back to an older cached list, or
     * undefined (stats are then shown by id). cacheOnly: never call the site (replay mode).
     */
    public async catalog(cacheOnly: boolean = false): Promise<ModCatalog | undefined> {
        if (this.modCatalog !== undefined) {
            return this.modCatalog;
        }
        const cached = this.options.statCache.statList();
        if (cached !== undefined && (cacheOnly || Date.now() - cached.fetchedAt < STAT_LIST_MAX_AGE_MS)) {
            this.modCatalog = new ModCatalog(cached.entries);
            return this.modCatalog;
        }
        if (cacheOnly) {
            return undefined;
        }
        try {
            const entries: TradeStatEntry[] = await this.client.stats();
            this.options.statCache.saveStatList(entries, Date.now());
            this.modCatalog = new ModCatalog(entries);
        } catch (error: unknown) {
            this.options.logger.area('trade').log('warn', 'stat list not fetched', { error: messageOf(error) });
            this.modCatalog = cached === undefined ? undefined : new ModCatalog(cached.entries);
        }
        return this.modCatalog;
    }

    public get signInState(): SignInState {
        return this.signIn;
    }

    public get rateState(): RateState {
        return this.rate;
    }

    /** Listens to the shared limiter (the Run view's rate-limit panel). Returns the unsubscribe. */
    public onLimiter(listener: (event: LimiterEvent<TradePolicy>) => void): () => void {
        this.limiterListeners.add(listener);
        return (): void => {
            this.limiterListeners.delete(listener);
        };
    }

    // Sign-in ----------------------------------------------------------------------------------------------

    /** Asks the site once (concurrent callers share the answer). */
    public check(): Promise<SignInState> {
        if (this.checking !== undefined) {
            return this.checking;
        }
        this.setSignIn({ status: 'checking', message: null, checkedAtMs: this.signIn.checkedAtMs });
        this.checking = this.probe().finally(() => {
            this.checking = undefined;
        });
        return this.checking;
    }

    public async openSignIn(): Promise<SignInState> {
        if (this.windowOpen) {
            return this.signIn;
        }
        this.windowOpen = true;
        this.setSignIn({ status: 'window-open', message: null, checkedAtMs: this.signIn.checkedAtMs });
        try {
            await openSignInWindow(this.options.logger.area('signin'));
        } catch (error: unknown) {
            return this.signInFailed('sign-in window failed', error);
        } finally {
            this.windowOpen = false;
        }
        return this.check();
    }

    /**
     * Sign out (D10, V15; no window since 22 Nov): the same POST My Account's Log out sends, which ends the
     * session on the site (signout.ts), then the app's trade session is cleared whatever the answer.
     */
    public async signOut(): Promise<SignInState> {
        if (this.windowOpen) {
            return this.signIn;
        }
        const log: Logger = this.options.logger.area('signin');
        const trade: Session = session.fromPartition(TRADE_PARTITION);
        try {
            const outcome: LogoutOutcome = await postLogout(trade);
            log.log(outcome.kind === 'failed' ? 'warn' : 'info', 'site log out', { ...outcome });
            // Proof the site ended it: the cookie it left behind must now read signed out (one search).
            const after: ProbeState | 'error' = await probeSignIn(this.client, this.options.league()).catch(() => 'error' as const);
            log.log(after === 'signed-out' ? 'info' : 'warn', 'after log out the site reads', { state: after });
            await trade.clearStorageData();
        } catch (error: unknown) {
            return this.signInFailed('sign-out failed', error);
        }
        log.log('info', 'signed out: trade session cleared');
        return this.setSignIn({ status: 'signed-out', message: null, checkedAtMs: Date.now() });
    }

    private signInFailed(what: string, error: unknown): SignInState {
        this.options.logger.area('signin').log('warn', what, { error: messageOf(error) });
        return this.setSignIn({ status: 'error', message: messageOf(error), checkedAtMs: Date.now() });
    }

    private async probe(): Promise<SignInState> {
        try {
            const state: ProbeState = await probeSignIn(this.client, this.options.league());
            return this.setSignIn({ status: state, message: null, checkedAtMs: Date.now() });
        } catch (error: unknown) {
            this.options.logger.area('signin').log('warn', 'sign-in check failed', { error: messageOf(error) });
            return this.setSignIn({ status: 'error', message: messageOf(error), checkedAtMs: Date.now() });
        }
    }

    private setSignIn(state: SignInState): SignInState {
        this.signIn = state;
        this.options.onSignIn(state);
        return state;
    }

    // The divine rate --------------------------------------------------------------------------------------

    /** The rate for the league; signal: the caller's Cancel (a run's prep), which lets it go at once. */
    public getRate(signal?: AbortSignal): Promise<RateState> {
        return this.withRate((league: string) => this.rates.current(league, signal));
    }

    /** The Refresh button. The cooldown lives in the rate client; a press during it changes nothing. */
    public refreshRate(): Promise<RateState> {
        if (this.rates.refreshBlocked()) {
            return Promise.resolve(this.rate);
        }
        return this.withRate((league: string) => this.rates.refresh(league));
    }

    public useGgg(): Promise<RateState> {
        return this.withRate((league: string) => this.rates.useGgg(league));
    }

    public setManualRate(chaosPerDivine: number): RateState {
        const league: string = this.options.league();
        const rate: DivineRate = this.rates.setManual(league, chaosPerDivine);
        return this.setRate({ league: league, rate: rateInfo(rate), busy: false, error: null, refreshBlockedUntilMs: this.blockedUntil() });
    }

    /** The rate a run uses (chaos per divine), or undefined when unknown. */
    public async chaosPerDivine(signal?: AbortSignal): Promise<number | undefined> {
        return (await this.getRate(signal)).rate?.chaosPerDivine;
    }

    private blockedUntil(): number | null {
        return this.rates.refreshBlockedUntil() ?? null;
    }

    private async withRate(lookup: (league: string) => Promise<RateLookup>): Promise<RateState> {
        const league: string = this.options.league();
        const before: RateInfo | null = this.rate.league === league ? this.rate.rate : null;
        this.setRate({ league: league, rate: before, busy: true, error: null, refreshBlockedUntilMs: this.blockedUntil() });
        try {
            const found: RateLookup = await lookup(league);
            const error: string | null =
                found.rate === undefined ? 'GGG had no Chaos/Divine rate for this league in the last few hours. Type one in.' : null;
            return this.setRate({
                league: league,
                rate: found.rate === undefined ? null : rateInfo(found.rate),
                busy: false,
                error: error,
                refreshBlockedUntilMs: this.blockedUntil(),
            });
        } catch (error: unknown) {
            return this.setRate({
                league: league,
                rate: before,
                busy: false,
                error: messageOf(error),
                refreshBlockedUntilMs: this.blockedUntil(),
            });
        }
    }

    private setRate(state: RateState): RateState {
        this.rate = state;
        this.options.onRate(state);
        return state;
    }
}
