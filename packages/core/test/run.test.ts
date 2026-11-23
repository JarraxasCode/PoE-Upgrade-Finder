import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimitStop, readItemDisplay, TradeError } from '@poe-upgrade-finder/trade';
import type { FetchResponse, SearchResponse, TradeListing, TradeSearchBody } from '@poe-upgrade-finder/trade';
import { priceBands } from '../src/bands.ts';
import { DEFAULT_FLOORS } from '../src/floors.ts';
import { deepenSlotSearch, interleave, runSlotSearch } from '../src/run.ts';
import type { EngineScore, RunEngine, RunEvent, RunResult, RunTrade } from '../src/run.ts';
import type { SlotSearchSpec } from '../src/spec.ts';
import { v1SpecBuilder } from '../src/v1.ts';
import { baseStats } from './fixtures.ts';

const RATE: number = 200;

function spec(budget: number): SlotSearchSpec {
    return v1SpecBuilder().build({
        slot: 'Boots',
        listingType: 'securable',
        priceBands: priceBands(budget, { overFactor: 1.25 }),
        characterLevel: 94,
        baseline: baseStats(),
        stripped: baseStats(),
        pobQuery: {
            category: { query: 'armour.boots' },
            query: { stats: [{ type: 'weight', filters: [{ id: 'pseudo.pseudo_total_life', weight: 1 }] }] },
        },
        floors: DEFAULT_FLOORS,
    });
}

function listing(id: string, amount: number, currency: string, gainPct: number, extra: Partial<TradeListing> = {}): TradeListing {
    return {
        id: id,
        text: `Rarity: Rare\n${id}\ngain:${gainPct}`,
        name: id,
        baseType: 'Sorcerer Boots',
        typeLine: 'Sorcerer Boots',
        rarity: 'Rare',
        ilvl: 84,
        identified: true,
        corrupted: false,
        statIds: [],
        statLines: [],
        price: { amount: amount, currency: currency, type: '~b/o' },
        indexed: undefined,
        seller: `s-${id}`,
        display: readItemDisplay({}),
        ...extra,
    };
}

/** Listings per (price option, max price edge); fetch serves them by id. */
class FakeTrade implements RunTrade {
    public readonly searches: TradeSearchBody[] = [];
    public readonly fetches: string[][] = [];
    private readonly byKey: Map<string, readonly TradeListing[]>;
    private readonly byId: Map<string, TradeListing> = new Map<string, TradeListing>();
    public failSearchAt: number | undefined;
    public stopAtFetch: number | undefined;
    /** Ids served as entries that failed validation. */
    public readonly malformedIds: Set<string> = new Set<string>();

    public constructor(byKey: Map<string, readonly TradeListing[]>) {
        this.byKey = byKey;
        for (const list of byKey.values()) {
            for (const l of list) {
                this.byId.set(l.id, l);
            }
        }
    }

    public search(_league: string, body: TradeSearchBody): Promise<SearchResponse> {
        this.searches.push(body);
        if (this.failSearchAt === this.searches.length) {
            return Promise.reject(new TradeError('site-error', 'search: Query is too complex', 400, 2));
        }
        const price = body.query.filters.trade_filters.filters.price;
        const ids: string[] = (this.byKey.get(`${price.option}:${price.max}`) ?? []).map((l: TradeListing) => l.id);
        return Promise.resolve({ id: `q${this.searches.length}`, ids: ids, total: ids.length * 10, inexact: false, complexity: 66 });
    }

    public fetch(ids: readonly string[]): Promise<FetchResponse> {
        this.fetches.push([...ids]);
        if (this.stopAtFetch === this.fetches.length) {
            return Promise.reject(new RateLimitStop(600_000, 'fetch ip window'));
        }
        const listings: TradeListing[] = [];
        const missing: string[] = [];
        const malformed: { readonly id: string; readonly error: string }[] = [];
        for (const id of ids) {
            const l: TradeListing | undefined = this.byId.get(id);
            if (this.malformedIds.has(id)) {
                malformed.push({ id: id, error: 'fetch.result[0].listing.price.amount: expected a number' });
            } else if (l === undefined || id.startsWith('gone')) {
                missing.push(id);
            } else {
                listings.push(l);
            }
        }
        return Promise.resolve({ listings: listings, missing: missing, malformed: malformed });
    }
}

/** "gain:X" in the text → DPS and EHP both up X%; "floor" breaks chaos res. */
const fakeEngine: RunEngine = {
    score(texts: readonly string[], onItem: (result: EngineScore) => void): Promise<void> {
        texts.forEach((text: string, index: number) => {
            if (text.includes('broken')) {
                onItem({ index: index, ok: false, message: 'parse error' });
                return;
            }
            const g: number = Number(/gain:(-?[\d.]+)/.exec(text)?.[1] ?? 0) / 100;
            const base = baseStats();
            const values: Record<string, number | boolean> = { ...base.values, TotalEHP: 100_000 * (1 + g) };
            if (text.includes('floor')) {
                values['ChaosResist'] = 30;
            }
            onItem({
                index: index,
                ok: true,
                stats: { damage: base.damage * (1 + g), values: values },
                unparsed: [],
                validForSlot: !text.includes('wrong-slot'),
            });
        });
        return Promise.resolve();
    },
};

test('interleave takes from each list in turn, up to its count', () => {
    assert.deepEqual(
        interleave(
            [
                ['a1', 'a2', 'a3'],
                ['b1', 'b2'],
            ],
            [3, 1],
        ),
        ['a1', 'b1', 'a2', 'a3'],
    );
    assert.deepEqual(interleave([['a1'], []], [5, 5]), ['a1']);
});

test('a run: bands cheapest first, divine search only from 1 div up, live items, junk filter and the pick', async () => {
    // Budget 300: bands ≤1, 1–33, 33–100, 100–300 (+ divine 0.5–1.5), over 300–375 (+ divine 1.5–1.88).
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            ['chaos:1', [listing('c1', 1, 'chaos', 0.4)]],
            [
                'chaos:33',
                [
                    listing('c20', 20, 'chaos', 4.5),
                    listing('c25-floor', 25, 'chaos', 9),
                    listing('c30-dup', 30, 'chaos', 4, { seller: 'S', text: 'same\ngain:4' }),
                    listing('gone1', 5, 'chaos', 1),
                ],
            ],
            [
                'chaos:100',
                [
                    listing('c80', 80, 'chaos', 5),
                    listing('c30-dup2', 28, 'chaos', 4, { seller: 'S', text: 'same\ngain:4' }),
                    listing('unid', 50, 'chaos', 3, { identified: false }),
                ],
            ],
            ['chaos:300', [listing('c250', 250, 'chaos', 5.5), listing('broken', 120, 'chaos', 1)]],
            ['divine:1.5', [listing('d1', 1.2, 'divine', 5.2), listing('c80', 80, 'chaos', 5)]],
            ['chaos:375', [listing('over', 350, 'chaos', 9)]],
            ['divine:1.88', [listing('d-over', 1.7, 'divine', 8.5)]],
        ]),
    );
    const events: RunEvent[] = [];
    const result: RunResult = await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE },
        trade,
        fakeEngine,
        (e: RunEvent) => {
            events.push(e);
        },
    );
    assert.equal(result.stoppedReason, undefined);
    assert.deepEqual(
        trade.searches.map(
            (b: TradeSearchBody) =>
                `${b.query.filters.trade_filters.filters.price.option}:${b.query.filters.trade_filters.filters.price.max}`,
        ),
        ['chaos:1', 'chaos:33', 'chaos:100', 'chaos:300', 'divine:1.5', 'chaos:375', 'divine:1.88'],
    );
    assert.ok(trade.fetches.every((f: string[]) => f.length <= 10));
    assert.equal(result.counts.missing, 1);
    assert.equal(result.counts.failed, 1);
    // c80 appeared in two searches of one band: fetched once.
    assert.equal(trade.fetches.flat().filter((id: string) => id === 'c80').length, 1);
    assert.ok(events.some((e: RunEvent) => e.kind === 'skipped' && e.reason === 'unidentified'));

    const hiddenOf = (id: string): string | undefined => result.items.find((f) => f.evaluated.item.id === id)?.hidden;
    assert.equal(hiddenOf('c1'), 'low-gain');
    assert.equal(hiddenOf('c25-floor'), 'floor');
    assert.equal(hiddenOf('c30-dup'), 'duplicate');
    assert.equal(hiddenOf('c20'), undefined);
    // Divine prices convert at the rate: 1.2 div = 240c.
    assert.equal(result.items.find((f) => f.evaluated.item.id === 'd1')?.evaluated.item.chaosEquivalent, 240);

    assert.equal(result.verdict.kind, 'pick');
    assert.ok(result.verdict.kind === 'pick');
    assert.equal(result.verdict.best.item.id, 'c250');
    assert.equal(result.verdict.pick.item.id, 'c20', 'cheapest with ≥ 80% of 5.5');
    assert.deepEqual(
        result.verdict.overBudget.map((e) => e.item.id),
        ['over', 'd-over'],
    );
});

test('a refused search is recorded and the run goes on; a rate-limit stop ends it with what it has', async () => {
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            ['chaos:33', [listing('a', 10, 'chaos', 3)]],
            ['chaos:100', [listing('b', 50, 'chaos', 4)]],
            ['chaos:300', [listing('c', 200, 'chaos', 6)]],
        ]),
    );
    trade.failSearchAt = 1;
    trade.stopAtFetch = 3;
    const result: RunResult = await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE },
        trade,
        fakeEngine,
        () => undefined,
    );
    assert.match(result.searches[0]?.error ?? '', /too complex/);
    assert.match(result.stoppedReason ?? '', /Rate limit/);
    assert.deepEqual(
        result.items.map((f) => f.evaluated.item.id),
        ['a', 'b'],
    );
    assert.ok(result.verdict.kind === 'pick' && result.verdict.pick.item.id === 'b');
});

test('no divine rate: chaos searches only, with a warning', async () => {
    const trade: FakeTrade = new FakeTrade(new Map<string, readonly TradeListing[]>());
    const events: RunEvent[] = [];
    await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 20, chaosPerDivine: undefined },
        trade,
        fakeEngine,
        (e: RunEvent) => {
            events.push(e);
        },
    );
    assert.ok(trade.searches.every((b: TradeSearchBody) => b.query.filters.trade_filters.filters.price.option === 'chaos'));
    assert.ok(events.some((e: RunEvent) => e.kind === 'warning' && /No divine rate/.test(e.message)));
});

test('search deeper: no search calls, fetches only ids not fetched yet, verdict over old and new', async () => {
    const many = (prefix: string, n: number, gainAt: (i: number) => number): TradeListing[] =>
        Array.from({ length: n }, (_v: unknown, i: number) => listing(`${prefix}${i}`, 150 + i, 'chaos', gainAt(i)));
    // The best item sits at rank 30 of the 100-300c search: a Quick run (20 per band) misses it.
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([['chaos:300', many('m', 60, (i: number) => (i === 30 ? 7 : 1.5))]]),
    );
    const input = { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, chaosPerDivine: RATE };
    const quick: RunResult = await runSlotSearch({ ...input, depth: 20 }, trade, fakeEngine, () => undefined);
    assert.equal(quick.counts.scored, 20);
    assert.ok(quick.verdict.kind === 'pick');
    assert.notEqual(quick.verdict.best.item.id, 'm30');
    const searchesBefore: number = trade.searches.length;
    const fetchedBefore: number = trade.fetches.flat().length;

    const events: RunEvent[] = [];
    const deep: RunResult = await deepenSlotSearch({ ...input, depth: 100 }, quick, trade, fakeEngine, (e: RunEvent) => {
        events.push(e);
    });
    assert.equal(trade.searches.length, searchesBefore, 'no new searches');
    const newIds: string[] = trade.fetches.flat().slice(fetchedBefore);
    assert.equal(newIds.length, 40);
    assert.ok(
        newIds.every((id: string) => !quick.fetchedIds.includes(id)),
        'nothing fetched twice',
    );
    assert.equal(deep.counts.scored, 60);
    assert.equal(deep.searches.length, quick.searches.length);
    assert.ok(deep.verdict.kind === 'pick');
    assert.equal(deep.verdict.best.item.id, 'm30');
    assert.equal(events.filter((e: RunEvent) => e.kind === 'item').length, 40, 'only the new items stream');
});

test('a stop mid-band: ids not fetched yet are not recorded as fetched, so Search deeper fetches them', async () => {
    const many: TradeListing[] = Array.from({ length: 30 }, (_v: unknown, i: number) => listing(`m${i}`, 150 + i, 'chaos', 2));
    const trade: FakeTrade = new FakeTrade(new Map<string, readonly TradeListing[]>([['chaos:300', many]]));
    trade.stopAtFetch = 2;
    const input = { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE };
    const first: RunResult = await runSlotSearch(input, trade, fakeEngine, () => undefined);
    assert.match(first.stoppedReason ?? '', /Rate limit/);
    assert.equal(first.fetchedIds.length, 10);
    trade.stopAtFetch = undefined;
    const deep: RunResult = await deepenSlotSearch(input, first, trade, fakeEngine, () => undefined);
    assert.equal(deep.counts.scored, 30);
});

test('a cancel while PoB scores the last items ends the run as cancelled', async () => {
    const trade: FakeTrade = new FakeTrade(new Map<string, readonly TradeListing[]>([['chaos:375', [listing('over', 350, 'chaos', 9)]]]));
    const controller: AbortController = new AbortController();
    // Like the real engine: a cancel returns normally, with the rest unscored.
    const cancellingEngine: RunEngine = {
        score(): Promise<void> {
            controller.abort();
            return Promise.resolve();
        },
    };
    const result: RunResult = await runSlotSearch(
        {
            league: 'Covens',
            spec: spec(300),
            baseline: baseStats(),
            blend: 0.5,
            depth: 100,
            chaosPerDivine: RATE,
            signal: controller.signal,
        },
        trade,
        cancellingEngine,
        () => undefined,
    );
    assert.equal(result.stoppedReason, 'Cancelled.');
});

test('a malformed listing is skipped with a warning; the rest of its batch is scored', async () => {
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            ['chaos:300', [listing('a', 150, 'chaos', 2), listing('bad', 160, 'chaos', 2), listing('c', 170, 'chaos', 2)]],
        ]),
    );
    trade.malformedIds.add('bad');
    const events: RunEvent[] = [];
    const result: RunResult = await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE },
        trade,
        fakeEngine,
        (e: RunEvent) => {
            events.push(e);
        },
    );
    assert.equal(result.counts.scored, 2);
    assert.equal(result.counts.skipped, 1);
    assert.ok(events.some((e: RunEvent) => e.kind === 'skipped' && e.listingId === 'bad' && e.reason === 'malformed'));
    assert.ok(events.some((e: RunEvent) => e.kind === 'warning' && /could not be read/.test(e.message)));
});
