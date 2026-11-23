import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HttpOutcome, HttpRequest } from '../src/http.ts';
import { pickHeaders } from '../src/http.ts';
import type { FetchResponse, SearchResponse } from '../src/listing.ts';
import type { TradeSearchBody } from '../src/query.ts';
import { RateLimiter, RateLimitStop } from '../src/rate-limiter.ts';
import type { TradePolicy } from '../src/rate-limiter.ts';
import { TradeClient, TradeError } from '../src/trade-client.ts';
import type { LogLevel, RecordedResponse } from '../src/trade-client.ts';
import { FakeClock, fetchHeaders, listingJson, response, ScriptedTransport, searchHeaders, signedOutSearchHeaders } from './helpers.ts';

interface LogLine {
    readonly level: LogLevel;
    readonly message: string;
    readonly data: Readonly<Record<string, unknown>> | undefined;
}

interface Rig {
    readonly client: TradeClient;
    readonly transport: ScriptedTransport;
    readonly clock: FakeClock;
    readonly logs: LogLine[];
    readonly recorded: RecordedResponse[];
}

function rig(script: readonly (HttpOutcome | ((request: HttpRequest) => HttpOutcome))[]): Rig {
    const clock: FakeClock = new FakeClock();
    const transport: ScriptedTransport = new ScriptedTransport(script);
    const logs: LogLine[] = [];
    const recorded: RecordedResponse[] = [];
    const client: TradeClient = new TradeClient({
        transport: transport,
        limiter: new RateLimiter<TradePolicy>({ clock: clock }),
        logger: {
            log(level: LogLevel, message: string, data?: Readonly<Record<string, unknown>>): void {
                logs.push({ level: level, message: message, data: data });
            },
        },
        now: () => clock.now(),
        onResponse: (r: RecordedResponse) => {
            recorded.push(r);
        },
    });
    return { client: client, transport: transport, clock: clock, logs: logs, recorded: recorded };
}

const BODY: TradeSearchBody = {
    query: {
        status: { option: 'securable' },
        stats: [{ type: 'weight', filters: [{ id: 'pseudo.pseudo_total_life', value: { weight: 1 } }] }],
        filters: {
            type_filters: { filters: { category: { option: 'armour.boots' }, rarity: { option: 'nonunique' } } },
            trade_filters: { filters: { price: { max: 5, option: 'chaos' } } },
        },
    },
    sort: { 'statgroup.0': 'desc' },
};

test('search posts the body to the league and reads the response', async () => {
    const r: Rig = rig([response(200, searchHeaders(1, 1), { id: 'q1', complexity: 66, result: ['a', 'b'], total: 10000 })]);
    const result: SearchResponse = await r.client.search('Covens of Umbra', BODY);
    assert.deepEqual(result, { id: 'q1', ids: ['a', 'b'], total: 10000, inexact: false, complexity: 66 });
    const sent: HttpRequest | undefined = r.transport.requests[0];
    assert.equal(sent?.url, 'https://www.pathofexile.com/api/trade/search/Covens%20of%20Umbra');
    assert.equal(sent?.method, 'POST');
    assert.deepEqual(JSON.parse(sent?.body ?? ''), BODY);
    assert.equal(r.client.signedIn, true);
    const line: LogLine | undefined = r.logs[0];
    assert.equal(line?.level, 'info');
    assert.equal(line?.data?.['complexity'], 66);
    assert.deepEqual(line?.data?.['body'], BODY);
});

test('fetch joins up to 10 ids, passes the query id and keeps the requested order', async () => {
    const r: Rig = rig([response(200, fetchHeaders(1), { result: [listingJson('b', 1, 'divine'), listingJson('a', 30, 'chaos')] })]);
    const result: FetchResponse = await r.client.fetch(['a', 'b'], 'q1');
    assert.equal(r.transport.requests[0]?.url, 'https://www.pathofexile.com/api/trade/fetch/a,b?query=q1');
    assert.deepEqual(
        result.listings.map((l: { readonly id: string }) => l.id),
        ['a', 'b'],
    );
    assert.throws(() => r.client.fetch([]), RangeError);
    assert.throws(() => r.client.fetch(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']), RangeError);
});

test('"Query is too complex" is a site error with the site code, not retried', async () => {
    const r: Rig = rig([
        response(400, searchHeaders(2, 2), {
            error: { code: 2, message: 'Query is too complex. Please reduce the amount of filters used.' },
        }),
    ]);
    await assert.rejects(r.client.search('Covens', BODY), (error: unknown) => {
        assert.ok(error instanceof TradeError);
        assert.equal(error.code, 'site-error');
        assert.equal(error.siteCode, 2);
        assert.equal(error.status, 400);
        assert.match(error.message, /too complex/);
        return true;
    });
    assert.equal(r.transport.requests.length, 1);
});

test('a 429 is retried once after its Retry-After', async () => {
    const r: Rig = rig([
        response(429, searchHeaders(3, 3, { 'retry-after': '20' }), { error: { code: 3, message: 'Rate limit exceeded' } }),
        response(200, searchHeaders(1, 4), { id: 'q1', result: [], total: 0 }),
    ]);
    const before: number = r.clock.now();
    await r.client.search('Covens', BODY);
    assert.equal(r.transport.requests.length, 2);
    assert.ok(r.clock.now() - before >= 20000);
});

test('a 429 with a long Retry-After stops the run instead of waiting', async () => {
    const r: Rig = rig([
        response(429, searchHeaders(3, 3, { 'retry-after': '600' }), { error: { code: 3, message: 'Rate limit exceeded' } }),
    ]);
    await assert.rejects(r.client.search('Covens', BODY), RateLimitStop);
    assert.equal(r.transport.requests.length, 1);
});

test('a 5xx or a timeout gets one retry, then fails', async () => {
    const ok: Rig = rig([response(502, {}, {}), response(200, searchHeaders(1, 1), { id: 'q', result: [], total: 0 })]);
    await ok.client.search('Covens', BODY);
    assert.equal(ok.transport.requests.length, 2);

    const bad: Rig = rig([{ kind: 'timeout' }, { kind: 'timeout' }]);
    await assert.rejects(bad.client.search('Covens', BODY), (error: unknown) => error instanceof TradeError && error.code === 'timeout');
    assert.equal(bad.transport.requests.length, 2);
});

test('Cloudflare and a lost session stop at once with their own codes', async () => {
    const cf: Rig = rig([response(403, { 'cf-mitigated': 'challenge' }, {})]);
    await assert.rejects(cf.client.search('Covens', BODY), (error: unknown) => error instanceof TradeError && error.code === 'cloudflare');

    const out: Rig = rig([response(200, signedOutSearchHeaders(), { id: 'q', result: [], total: 0 })]);
    await assert.rejects(out.client.search('Covens', BODY), (error: unknown) => error instanceof TradeError && error.code === 'signed-out');
    assert.equal(out.client.signedIn, false);

    const redirect: Rig = rig([{ kind: 'redirect', status: 302, location: 'https://www.pathofexile.com/login' }]);
    await assert.rejects(
        redirect.client.search('Covens', BODY),
        (error: unknown) => error instanceof TradeError && error.code === 'redirect' && /\/login/.test(error.message),
    );
});

test('a cancelled call rejects with CancelledError', async () => {
    const r: Rig = rig([{ kind: 'aborted' }]);
    await assert.rejects(r.client.search('Covens', BODY), { name: 'CancelledError' });
});

test('an unexpected 200 body is a bad-response error naming the field', async () => {
    const r: Rig = rig([response(200, searchHeaders(1, 1), { id: 'q', total: 1 })]);
    await assert.rejects(
        r.client.search('Covens', BODY),
        (error: unknown) => error instanceof TradeError && error.code === 'bad-response' && /search\.result/.test(error.message),
    );
});

test('every response with a body is handed to onResponse', async () => {
    const r: Rig = rig([response(200, fetchHeaders(1), { result: [listingJson('a', 1, 'chaos')] })]);
    await r.client.fetch(['a']);
    assert.equal(r.recorded.length, 1);
    assert.equal(r.recorded[0]?.policy, 'fetch');
});

test('pickHeaders keeps only rate-limit, Retry-After and cf-mitigated headers', () => {
    const picked = pickHeaders([
        ['Set-Cookie', ['POESESSID=secret', 'other=1']],
        ['X-Rate-Limit-Rules', 'Account,Ip'],
        ['Retry-After', '5'],
        ['cf-mitigated', 'challenge'],
        ['Authorization', 'Bearer x'],
    ]);
    assert.deepEqual(picked, { 'x-rate-limit-rules': 'Account,Ip', 'retry-after': '5', 'cf-mitigated': 'challenge' });
});
