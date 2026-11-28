// Ported from spike/test/rate-limiter.test.js, with the same recorded header strings.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRateHeaders, RateLimiter, RateLimitStop } from '../src/rate-limiter.ts';
import type { LimiterEvent, ParsedRateHeaders, TradePolicy, WaitDecision } from '../src/rate-limiter.ts';
import { FakeClock, fetchHeaders, searchHeaders } from './helpers.ts';

function makeLimiter(clock: FakeClock, events?: LimiterEvent<TradePolicy>[]): RateLimiter<TradePolicy> {
    return new RateLimiter<TradePolicy>({
        clock: clock,
        onEvent: (event: LimiterEvent<TradePolicy>): void => {
            events?.push(event);
        },
    });
}

test('parses rules, limits and state per window', () => {
    const parsed: ParsedRateHeaders | undefined = parseRateHeaders(searchHeaders(1, 1));
    assert.ok(parsed);
    assert.equal(parsed.policy, 'trade-search-request-limit');
    assert.deepEqual(Object.keys(parsed.rules), ['account', 'ip']);
    assert.deepEqual(parsed.rules['account'], [{ limit: 3, period: 5, restrict: 60, hits: 1, active: 0 }]);
    assert.equal(parsed.rules['ip']?.length, 4);
    assert.deepEqual(parsed.rules['ip']?.[3], { limit: 600, period: 10800, restrict: 3600, hits: 1, active: 0 });
});

test('no rules header means nothing parsed', () => {
    assert.equal(parseRateHeaders({ 'content-type': 'application/json' }), undefined);
});

test('headroom: account 3:5 allows 2 per 5 s', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    const sendTimes: number[] = [];
    for (let i: number = 1; i <= 3; i++) {
        await limiter.schedule('search', `s${i}`, async () => {
            sendTimes.push(clock.now());
            limiter.update('search', searchHeaders(i, i), 200);
        });
    }
    assert.equal((sendTimes[1] ?? 0) - (sendTimes[0] ?? 0), 0);
    // The third search waits until the first one leaves the 5 s window.
    assert.equal((sendTimes[2] ?? 0) - (sendTimes[0] ?? 0), 5000);
});

test('first request of an unknown policy goes straight away', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    await limiter.schedule('fetch', 'f1', async () => null);
    assert.deepEqual(clock.slept, []);
});

test('uses the server count when it is higher than ours (e.g. the browser also searched)', async () => {
    const clock: FakeClock = new FakeClock();
    const events: LimiterEvent<TradePolicy>[] = [];
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock, events);
    await limiter.schedule('search', 's1', async () => {
        // The server says 10 hits in the 60 s window: our allowance there is floor(0.7 × 15) = 10.
        limiter.update('search', searchHeaders(1, 10), 200);
    });
    await limiter.schedule('search', 's2', async () => null);
    const wait: LimiterEvent<TradePolicy> | undefined = events.find((e: LimiterEvent<TradePolicy>) => e.kind === 'wait');
    assert.ok(wait?.kind === 'wait', 'expected a wait');
    assert.match(wait.reason, /15 per 60s/);
    assert.equal(wait.waitMs, 60000);
});

test('counts every request sent, even ones that failed', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    limiter.update('search', searchHeaders(0, 0), 200);
    await assert.rejects(
        limiter.schedule('search', 'a', async () => {
            throw new Error('timeout');
        }),
    );
    await assert.rejects(
        limiter.schedule('search', 'b', async () => {
            throw new Error('timeout');
        }),
    );
    const decision: WaitDecision = limiter.computeWait('search');
    assert.equal(decision.waitMs, 5000);
});

test('429 with a short Retry-After waits; a long one stops', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    await limiter.schedule('search', 's1', async () => {
        limiter.update('search', searchHeaders(1, 1, { 'retry-after': '20' }), 429);
    });
    const before: number = clock.now();
    await limiter.schedule('search', 's2', async () => null);
    assert.equal(clock.now() - before, 20000);

    limiter.update('search', searchHeaders(1, 1, { 'retry-after': '600' }), 429);
    await assert.rejects(
        limiter.schedule('search', 's3', async () => null),
        RateLimitStop,
    );
});

test('an active server restriction of 5 minutes or more stops the run', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    limiter.update('search', { ...searchHeaders(3, 3), 'x-rate-limit-account-state': '4:5:600' }, 200);
    await assert.rejects(
        limiter.schedule('search', 's', async () => null),
        RateLimitStop,
    );
});

test('a cancelled signal stops a waiting request before it is sent', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    const controller: AbortController = new AbortController();
    controller.abort();
    let sent: boolean = false;
    await assert.rejects(
        limiter.schedule(
            'search',
            's',
            async () => {
                sent = true;
            },
            controller.signal,
        ),
        { name: 'CancelledError' },
    );
    assert.equal(sent, false);
});

test('one request in flight at a time', async () => {
    const limiter: RateLimiter<string> = new RateLimiter<string>();
    let inFlight: number = 0;
    let maxInFlight: number = 0;
    const tasks: Promise<void>[] = [];
    for (let i: number = 0; i < 5; i++) {
        tasks.push(
            limiter.schedule(`k${i}`, 't', async () => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise<void>((resolve: () => void) => {
                    setTimeout(resolve, 5);
                });
                inFlight--;
            }),
        );
    }
    await Promise.all(tasks);
    assert.equal(maxInFlight, 1);
});

test('a sweep of 60 searches never exceeds 70% of any window', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    const sendTimes: number[] = [];
    for (let i: number = 0; i < 60; i++) {
        await limiter.schedule('search', `s${i}`, async () => {
            sendTimes.push(clock.now());
            limiter.update(
                'search',
                {
                    'x-rate-limit-rules': 'Account,Ip',
                    'x-rate-limit-account': '3:5:60',
                    'x-rate-limit-ip': '8:10:60,15:60:120,60:300:1800,600:10800:3600',
                },
                200,
            );
        });
    }
    const windows: readonly (readonly [number, number])[] = [
        [5, 2],
        [10, 5],
        [60, 10],
        [300, 42],
        [10800, 420],
    ];
    for (const [period, allowed] of windows) {
        for (const t of sendTimes) {
            const inWindow: number = sendTimes.filter((s: number) => s > t - period * 1000 && s <= t).length;
            assert.ok(inWindow <= allowed, `${inWindow} sends in a ${period}s window (allowed ${allowed})`);
        }
    }
    // 42 per 5 min is the binding window: 60 searches take a bit over 5 minutes.
    const totalSeconds: number = ((sendTimes[59] ?? 0) - (sendTimes[0] ?? 0)) / 1000;
    assert.ok(totalSeconds > 300 && totalSeconds < 480, `took ${totalSeconds}s`);
});

test('snapshot reports each window as count of allowed', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    await limiter.schedule('search', 's1', async () => {
        limiter.update('search', searchHeaders(1, 4), 200);
    });
    const search = limiter.snapshot().get('search');
    assert.ok(search);
    assert.deepEqual(search.windows[0], { rule: 'account', count: 1, local: 1, server: 1, allowed: 2, limit: 3, period: 5, restrict: 60 });
    assert.equal(search.windows[1]?.count, 4);
});

test('a full server count made of our own sends waits only until the oldest leaves the window', async () => {
    // 10 searches 6 s apart, each response counting them all (ip 15:60 → we allow 10). The 11th waits for the
    // first to leave the 60 s window (6 s), not a whole period from the last response (60 s). 22 Nov: a run
    // stalled 300 s on the fetch window where 61 s was enough.
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    for (let i: number = 1; i <= 10; i++) {
        await limiter.schedule('search', `s${i}`, async () => {
            // As the site counts them: the 10 s window holds the last two sends, the longer ones all of them.
            limiter.update(
                'search',
                searchHeaders(1, i, { 'x-rate-limit-ip-state': `${Math.min(i, 2)}:10:0,${i}:60:0,${i}:300:0,${i}:10800:0` }),
                200,
            );
        });
        clock.t += 6000;
    }
    clock.t -= 6000;
    const decision: WaitDecision = limiter.computeWait('search');
    assert.equal(decision.waitMs, 6000);
});

test('hits the server counts that we never sent are placed at the response, the latest they can be', () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = makeLimiter(clock);
    // Nothing sent by us; the server says the 60 s window already holds 10 (the browser searched).
    limiter.update('search', searchHeaders(0, 10), 200);
    clock.t += 20_000;
    assert.equal(limiter.computeWait('search').waitMs, 40_000);
});

// ---- Issue #79: never unpaced, and a rule we can't read ----------------------------------------------

function pacedLimiter(clock: FakeClock, events?: LimiterEvent<TradePolicy>[]): RateLimiter<TradePolicy> {
    return new RateLimiter<TradePolicy>({
        clock: clock,
        pacedWithoutRules: ['search', 'fetch'],
        onEvent: (event: LimiterEvent<TradePolicy>): void => {
            events?.push(event);
        },
    });
}

test('the real fetch header shapes parse with nothing malformed (Account 6:4:10; Ip 12:4:60,16:12:60,100:300:300,1000:10800:1800)', () => {
    const parsed: ParsedRateHeaders | undefined = parseRateHeaders(fetchHeaders(2));
    assert.ok(parsed);
    assert.deepEqual(parsed.malformed, []);
    assert.deepEqual(parsed.rules['account'], [{ limit: 6, period: 4, restrict: 10, hits: 2, active: 0 }]);
    assert.deepEqual(
        parsed.rules['ip']?.map((w) => [w.limit, w.period, w.restrict]),
        [
            [12, 4, 60],
            [16, 12, 60],
            [100, 300, 300],
            [1000, 10800, 1800],
        ],
    );
});

test('a named rule whose limits are missing or garbled is malformed', () => {
    for (const account of [undefined, '', '6:4', 'six:4:10', '6:4:10,', '0:4:10']) {
        const headers: Record<string, string> = { ...fetchHeaders(1) };
        if (account === undefined) {
            delete headers['x-rate-limit-account'];
        } else {
            headers['x-rate-limit-account'] = account;
        }
        assert.deepEqual(parseRateHeaders(headers)?.malformed, ['account'], String(account));
    }
});

test('a search or fetch with no usable rules goes one request per 10 s, never unpaced; data is not paced', async () => {
    const clock: FakeClock = new FakeClock();
    const events: LimiterEvent<TradePolicy>[] = [];
    const limiter: RateLimiter<TradePolicy> = pacedLimiter(clock, events);
    const start: number = clock.now();
    const sent: number[] = [];
    for (let i: number = 0; i < 3; i++) {
        await limiter.schedule('fetch', `f${i}`, async () => {
            sent.push(clock.now() - start);
            limiter.update('fetch', {}, 200);
        });
    }
    assert.deepEqual(sent, [0, 10000, 20000]);
    assert.ok(events.some((e) => e.kind === 'unusable' && e.key === 'fetch'));

    const before: number = clock.now();
    for (let i: number = 0; i < 3; i++) {
        await limiter.schedule('data', `d${i}`, async () => {
            limiter.update('data', {}, 200);
        });
    }
    assert.equal(clock.now(), before);
});

test('a rule that turns unreadable keeps its last good windows; with none known, the fallback pacing holds', async () => {
    const clock: FakeClock = new FakeClock();
    const events: LimiterEvent<TradePolicy>[] = [];
    const limiter: RateLimiter<TradePolicy> = pacedLimiter(clock, events);
    const garbled = (accountHits: number, ipHits: number): Record<string, string> => ({
        ...searchHeaders(accountHits, ipHits),
        'x-rate-limit-account': 'garbage',
    });
    const start: number = clock.now();
    const sent: number[] = [];
    // Account 3:5 allows 2 per 5 s. Without it, Ip 8:10 would allow 5 and the third search would go at once.
    await limiter.schedule('search', 's1', async () => {
        sent.push(clock.now() - start);
        limiter.update('search', searchHeaders(1, 1), 200);
    });
    for (let i: number = 2; i <= 3; i++) {
        await limiter.schedule('search', `s${i}`, async () => {
            sent.push(clock.now() - start);
            limiter.update('search', garbled(i, i), 200);
        });
    }
    assert.deepEqual(sent, [0, 0, 5000]);
    assert.ok(events.some((e) => e.kind === 'unusable' && /keeping its last good windows/.test(e.reason)));

    // A fresh limiter that has only ever seen the garbled rule: Ip alone would allow 5, the fallback says 1 per 10 s.
    const fresh: RateLimiter<TradePolicy> = pacedLimiter(new FakeClock());
    const decisions: WaitDecision[] = [];
    await fresh.schedule('search', 's1', async () => {
        fresh.update('search', garbled(1, 1), 200);
    });
    decisions.push(fresh.computeWait('search'));
    assert.equal(decisions[0]?.waitMs, 10000);
});

test('a 429 with an active restriction and no Retry-After waits out the longer of the two', async () => {
    const clock: FakeClock = new FakeClock();
    const limiter: RateLimiter<TradePolicy> = pacedLimiter(clock);
    // No Retry-After: 60 s by default; the server says Account is restricting for 120 s.
    limiter.update('search', { ...searchHeaders(4, 4), 'x-rate-limit-account-state': '4:5:120' }, 429);
    assert.equal(limiter.computeWait('search').waitMs, 120_000);
    limiter.update('fetch', fetchHeaders(7), 429);
    assert.equal(limiter.computeWait('fetch').waitMs, 60_000);
});
