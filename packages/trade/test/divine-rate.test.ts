import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DivineRateClient, isOutOfDate, lastFinishedHour, manualRate, readDigest } from '../src/divine-rate.ts';
import type { DivineRate, RateLookup } from '../src/divine-rate.ts';
import type { HttpOutcome, HttpRequest, HttpTransport } from '../src/http.ts';
import { silent } from './log.ts';
import { FakeClock } from './helpers.ts';

const CHAOS: string = 'Metadata/Items/Currency/CurrencyRerollRare';
const DIVINE: string = 'Metadata/Items/Currency/CurrencyModValues';

function digest(markets: readonly unknown[], next: number = 0): string {
    return JSON.stringify({ next_change_id: next, markets: markets });
}

function market(league: string, id: string, chaos: number, divine: number): unknown {
    const [a = '', b = ''] = id.split('|');
    return {
        league: league,
        market_id: id,
        market_pair: [a, b],
        volume_traded: { [CHAOS]: chaos, [DIVINE]: divine, [a]: chaos, [b]: divine },
    };
}

/** Serves digests by hour id; any other hour is GGG's 404. */
class DigestTransport implements HttpTransport {
    public readonly asked: number[] = [];
    public readonly userAgents: string[] = [];
    private readonly byHour: ReadonlyMap<number, string>;

    public constructor(byHour: ReadonlyMap<number, string>) {
        this.byHour = byHour;
    }

    public send(request: HttpRequest): Promise<HttpOutcome> {
        const hour: number = Number(request.url.split('/').pop());
        this.asked.push(hour);
        this.userAgents.push(request.headers['User-Agent'] ?? '');
        const text: string | undefined = this.byHour.get(hour);
        if (text === undefined) {
            return Promise.resolve({
                kind: 'response',
                status: 404,
                headers: {},
                text: JSON.stringify({ next_change_id: hour, markets: [] }),
            });
        }
        return Promise.resolve({ kind: 'response', status: 200, headers: {}, text: text });
    }
}

function client(transport: HttpTransport, clock: FakeClock): DivineRateClient {
    return new DivineRateClient({ transport: transport, logger: silent, appVersion: '0.1.0', clock: clock });
}

const H10: number = 1795255200; // 21 Nov 2026 10:00 UTC
const H11: number = H10 + 3600;

test('the last finished hour is the hour before the current one', () => {
    assert.equal(lastFinishedHour((H11 + 46 * 60) * 1000), H10);
    assert.equal(lastFinishedHour(H11 * 1000), H10);
    assert.equal(lastFinishedHour(H11 * 1000 - 1), H10 - 3600);
});

test('readDigest takes the exact Chaos|Divine market of the league, by volume', () => {
    const text: unknown = JSON.parse(
        digest([
            market('Covens', `${CHAOS}Veiled|${DIVINE}`, 177, 10),
            market('Standard', `${CHAOS}|${DIVINE}`, 234472, 281),
            market('Covens', `${CHAOS}|${DIVINE}`, 13331458, 63493),
        ]),
    );
    const reading = readDigest(text, 'Covens');
    assert.equal(reading.kind, 'rate');
    assert.ok(reading.kind === 'rate' && Math.abs(reading.chaosPerDivine - 209.9674) < 0.0001);
    assert.equal(readDigest(text, 'Hardcore').kind, 'no-market');
    assert.equal(readDigest({ next_change_id: 1, markets: [] }, 'Covens').kind, 'no-markets');
    assert.equal(readDigest(JSON.parse(digest([market('Covens', `${CHAOS}|${DIVINE}`, 0, 0)])), 'Covens').kind, 'no-volume');
});

test('steps back past the 404 of an unfinished hour and caches the rate', async () => {
    const clock: FakeClock = new FakeClock();
    clock.t = (H11 + 3600 + 46 * 60) * 1000; // 12:46: last finished hour 11:00 has no digest yet
    const transport: DigestTransport = new DigestTransport(
        new Map<number, string>([[H10, digest([market('Covens', `${CHAOS}|${DIVINE}`, 2000, 10)])]]),
    );
    const rates: DivineRateClient = client(transport, clock);
    const first: RateLookup = await rates.current('Covens');
    assert.equal(first.rate?.chaosPerDivine, 200);
    assert.equal(first.rate?.hour, H10);
    assert.deepEqual(transport.asked, [H11, H10]);
    assert.deepEqual(transport.userAgents, ['poe-upgrade-finder/0.1.0', 'poe-upgrade-finder/0.1.0']);

    // Out of date (11:00 should exist by now), so the next lookup tries 11:00 again; nothing older is re-asked.
    assert.equal(first.rate !== undefined && isOutOfDate(first.rate, clock.t), true);
    const second: RateLookup = await rates.current('Covens');
    assert.deepEqual(transport.asked, [H11, H10, H11]);
    assert.equal(second.rate?.chaosPerDivine, 200, 'keeps the older rate when nothing newer answers');
});

test('a fresh cached rate is served without calling GGG', async () => {
    const clock: FakeClock = new FakeClock();
    clock.t = (H11 + 10 * 60) * 1000;
    const transport: DigestTransport = new DigestTransport(
        new Map<number, string>([[H10, digest([market('Covens', `${CHAOS}|${DIVINE}`, 2080, 10)])]]),
    );
    const rates: DivineRateClient = client(transport, clock);
    await rates.current('Covens');
    const again: RateLookup = await rates.current('Covens');
    assert.equal(again.fetched, false);
    assert.equal(transport.asked.length, 1);
});

test('nothing at all: the rate is undefined, so the user types it in; a manual rate then sticks', async () => {
    const clock: FakeClock = new FakeClock();
    clock.t = (H11 + 10 * 60) * 1000;
    const transport: DigestTransport = new DigestTransport(new Map<number, string>());
    const rates: DivineRateClient = client(transport, clock);
    const lookup: RateLookup = await rates.current('Covens');
    assert.equal(lookup.rate, undefined);
    assert.equal(lookup.attempts.length, 6);
    const manual: DivineRate = rates.setManual('Covens', 215);
    assert.deepEqual((await rates.current('Covens')).rate, manual);
    assert.equal(transport.asked.length, 6, 'a manual rate never calls GGG');
    assert.throws(() => manualRate(0, 0), RangeError);
});

test('Use GGG with nothing from GGG drops the manual rate, so a run does not use it silently', async () => {
    const clock: FakeClock = new FakeClock();
    clock.t = (H11 + 10 * 60) * 1000;
    const rates: DivineRateClient = client(new DigestTransport(new Map<number, string>()), clock);
    rates.setManual('Covens', 150);
    assert.equal((await rates.useGgg('Covens')).rate, undefined);
    assert.equal((await rates.current('Covens')).rate, undefined);
});

test('Refresh calls GGG only when out of date, and at most once per 30 s', async () => {
    const clock: FakeClock = new FakeClock();
    clock.t = (H11 + 10 * 60) * 1000;
    const transport: DigestTransport = new DigestTransport(
        new Map<number, string>([[H10, digest([market('Covens', `${CHAOS}|${DIVINE}`, 2080, 10)])]]),
    );
    const rates: DivineRateClient = client(transport, clock);
    await rates.refresh('Covens');
    assert.equal(transport.asked.length, 1);
    await rates.refresh('Covens'); // fresh: from the store
    assert.equal(transport.asked.length, 1);
    clock.t += 3600 * 1000; // an hour later: out of date, and well past the 30 s cooldown
    await rates.refresh('Covens');
    assert.equal(transport.asked.length, 2);
    await rates.refresh('Covens'); // 0 s later: cooling down
    assert.equal(transport.asked.length, 2);
});

// The V21 recording: the 09:00 and 10:00 UTC digests of 21 Nov and the 404 for 11:00.
// Cut to four leagues (tools/fixtures/make-fixtures.ts); in the private repo's test/fixtures/ only.
const V21_DIR: string = fileURLToPath(new URL('../../../test/fixtures/currency/', import.meta.url));
const haveV21: boolean = existsSync(join(V21_DIR, `ggg-${H10}.json`));

test(
    'reproduces V21 on the recorded digests: Covens 207.9 at 10:00, 210.0 at 09:00',
    { skip: haveV21 ? false : `no recording in ${V21_DIR}` },
    async () => {
        const byHour: Map<number, string> = new Map<number, string>();
        for (const hour of [H10 - 3600, H10]) {
            byHour.set(hour, readFileSync(join(V21_DIR, `ggg-${hour}.json`), 'utf8'));
        }
        const recorded404: unknown = JSON.parse(readFileSync(join(V21_DIR, `ggg-${H11}.json`), 'utf8'));
        assert.deepEqual(recorded404, { next_change_id: H11, markets: [] });

        const clock: FakeClock = new FakeClock();
        clock.t = (H11 + 3600 + 46 * 60) * 1000;
        const rates: DivineRateClient = client(new DigestTransport(byHour), clock);
        const lookup: RateLookup = await rates.current('Covens');
        assert.equal(lookup.rate?.hour, H10);
        assert.equal(Math.round((lookup.rate?.chaosPerDivine ?? 0) * 10) / 10, 207.9);

        const nine = readDigest(JSON.parse(byHour.get(H10 - 3600) ?? ''), 'Covens');
        assert.ok(nine.kind === 'rate' && Math.round(nine.chaosPerDivine * 10) / 10 === 210.0);
        const hc = readDigest(JSON.parse(byHour.get(H10 - 3600) ?? ''), 'Hardcore Covens');
        assert.ok(hc.kind === 'rate' && Math.round(hc.chaosPerDivine * 10) / 10 === 130.4);
    },
);
