import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RateLimitStop, readFetchResponse, readItemDisplay, TradeError } from '@poe-upgrade-finder/trade';
import type { FetchResponse, SearchResponse, StatSource, TradeListing, TradeSearchBody } from '@poe-upgrade-finder/trade';
import { priceBands } from '../src/bands.ts';
import { DEFAULT_FLOORS } from '../src/floors.ts';
import { deepenSlotSearch, interleave, offHandName, offHandWarning, runSlotSearch } from '../src/run.ts';
import type { EngineScore, RunEngine, RunEvent, RunResult, RunTrade } from '../src/run.ts';
import type { SlotSearchSpec } from '../src/spec.ts';
import { baseStats, emptyPlanSpec } from './fixtures.ts';

const RATE: number = 200;

function spec(budget: number): SlotSearchSpec {
    return emptyPlanSpec({
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
        statSources: [],
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
    /** A second 429 in a row at this search (issue #79). */
    public rateLimitedSearchAt: number | undefined;
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
        if (this.rateLimitedSearchAt === this.searches.length) {
            return Promise.reject(new TradeError('rate-limited', 'search: rate limited again after waiting out the first limit.', 429));
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
                offHandRemoved: text.includes('two-hand'),
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

test('interleave tops up past ids an earlier band fetched, and passes them through once (#111)', () => {
    const fetched: ReadonlySet<string> = new Set<string>(['a1', 'b1']);
    assert.deepEqual(
        interleave(
            [
                ['a1', 'a2', 'a3'],
                ['b1', 'b2', 'b3'],
            ],
            [1, 2],
            (id: string) => fetched.has(id),
        ),
        ['a1', 'a2', 'b1', 'b2', 'b3'],
    );
    // The same id in two lists comes out once and counts once.
    assert.deepEqual(
        interleave(
            [
                ['x', 'a'],
                ['x', 'b'],
            ],
            [1, 1],
        ),
        ['x', 'b'],
    );
});

test('a band whose top listing an earlier band fetched still fetches its share, priced into its role (#111)', async () => {
    // Depth 1 per band. 'dup' (300c, exactly the budget) comes back from the top band and the over band.
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            ['chaos:300', [listing('dup', 300, 'chaos', 5)]],
            ['chaos:375', [listing('dup', 300, 'chaos', 5), listing('o2', 340, 'chaos', 9)]],
        ]),
    );
    const events: RunEvent[] = [];
    const result: RunResult = await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 1, chaosPerDivine: undefined },
        trade,
        fakeEngine,
        (e: RunEvent) => {
            events.push(e);
        },
    );
    assert.deepEqual(trade.fetches, [['dup'], ['o2']]);
    assert.ok(events.some((e: RunEvent) => e.kind === 'skipped' && e.reason === 'already-fetched' && e.listingId === 'dup'));
    const roleOf = (id: string): string | undefined => result.items.find((f) => f.evaluated.item.id === id)?.evaluated.item.role;
    assert.equal(roleOf('dup'), 'main');
    assert.equal(roleOf('o2'), 'over');
    assert.ok(result.verdict.kind === 'pick' && result.verdict.pick.item.id === 'dup');
});

test('"N listings in budget" counts a listing two bands returned once (#111)', async () => {
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            ['chaos:100', [listing('broken-a', 100, 'chaos', 1)]],
            ['chaos:300', [listing('broken-a', 100, 'chaos', 1), listing('broken-b', 200, 'chaos', 1)]],
        ]),
    );
    const result: RunResult = await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: undefined },
        trade,
        fakeEngine,
        () => undefined,
    );
    assert.equal(result.verdict.note, 'No upgrade found: none of the 2 listings in budget could be scored (the run summary says why).');
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

test('a repeated 429 (rate-limited) stops the run instead of moving on to the next band (issue #79)', async () => {
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            ['chaos:33', [listing('a', 10, 'chaos', 3)]],
            ['chaos:100', [listing('b', 50, 'chaos', 4)]],
            ['chaos:300', [listing('c', 200, 'chaos', 6)]],
        ]),
    );
    trade.rateLimitedSearchAt = 1;
    const result: RunResult = await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE },
        trade,
        fakeEngine,
        () => undefined,
    );
    assert.match(result.stoppedReason ?? '', /rate limited again/);
    assert.equal(trade.searches.length, 1);
    assert.equal(trade.fetches.length, 0);
});

test('results scored without the off-hand get one warning naming it (#39, #101)', async () => {
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            [
                'chaos:300',
                [listing('one-hand', 150, 'chaos', 2), listing('two-hand-a', 160, 'chaos', 2), listing('two-hand-b', 170, 'chaos', 3)],
            ],
        ]),
    );
    const events: RunEvent[] = [];
    const result: RunResult = await runSlotSearch(
        { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE, offHand: 'shield' },
        trade,
        fakeEngine,
        (e: RunEvent) => {
            events.push(e);
        },
    );
    assert.equal(result.counts.scored, 3, 'they are still scored and shown');
    const warnings: string[] = events.flatMap((e: RunEvent) =>
        e.kind === 'warning' && /off-hand|beside your/.test(e.message) ? [e.message] : [],
    );
    assert.deepEqual(warnings, [offHandWarning('shield')]);
    assert.match(warnings[0] ?? '', /beside your shield: they were scored without it/);
});

test('offHandName names the saved Weapon 2 by its type', () => {
    assert.equal(offHandName('Shield'), 'shield');
    assert.equal(offHandName('Quiver'), 'quiver');
    assert.equal(offHandName('Wand'), 'off-hand weapon');
    assert.equal(offHandName(undefined), 'off-hand');
});

test("listings PoB won't equip are counted by reason, with a warning when most of a band is (#39)", async () => {
    const trade: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([
            [
                'chaos:300',
                [
                    listing('ok', 150, 'chaos', 2),
                    listing('wrong-slot-a', 160, 'chaos', 2),
                    listing('wrong-slot-b', 170, 'chaos', 2),
                    listing('wrong-slot-c', 175, 'chaos', 2),
                    listing('unid', 180, 'chaos', 2, { identified: false }),
                ],
            ],
        ]),
    );
    const events: RunEvent[] = [];
    const input = { league: 'Covens', spec: spec(300), baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE };
    const result: RunResult = await runSlotSearch({ ...input, besides: 'beside a Wand' }, trade, fakeEngine, (e: RunEvent) => {
        events.push(e);
    });
    assert.equal(result.counts.skipped, 4);
    assert.deepEqual(result.counts.skippedBy, {
        'not-for-slot': 3,
        unidentified: 1,
        'already-fetched': 0,
        malformed: 0,
        'excluded-mod': 0,
    });
    const warnings: string[] = events.flatMap((e: RunEvent) => (e.kind === 'warning' && /won't equip/.test(e.message) ? [e.message] : []));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /: PoB won't equip 3 of 5 listings in Boots beside a Wand, so they were skipped\.$/);

    // Half or fewer: no warning. A deeper pass carries the counts over.
    const fewer: FakeTrade = new FakeTrade(
        new Map<string, readonly TradeListing[]>([['chaos:300', [listing('ok', 150, 'chaos', 2), listing('wrong-slot', 160, 'chaos', 2)]]]),
    );
    const quiet: RunEvent[] = [];
    const first: RunResult = await runSlotSearch(input, fewer, fakeEngine, (e: RunEvent) => {
        quiet.push(e);
    });
    assert.equal(
        quiet.some((e: RunEvent) => e.kind === 'warning' && /won't equip/.test(e.message)),
        false,
    );
    const deeper: RunResult = await deepenSlotSearch(input, first, fewer, fakeEngine, () => undefined);
    assert.equal(deeper.counts.skippedBy['not-for-slot'], 1);
});

// #38 on real mod indices: three V19 boots (test/fixtures/trade, private repo only). Deacon's has flat ES and mana
// from one mod (the hybrid); fc82... has both stats from separate mods (an ES + life hybrid and the pure mana prefix).
const V19_FILE: string = fileURLToPath(new URL('../../../test/fixtures/trade/v19-boots-raw.json', import.meta.url));

function v19Sources(): ReadonlyMap<string, readonly StatSource[]> {
    const raw: unknown = JSON.parse(readFileSync(V19_FILE, 'utf8'));
    assert.ok(typeof raw === 'object' && raw !== null && 'fetch' in raw && Array.isArray(raw.fetch));
    const out: Map<string, readonly StatSource[]> = new Map<string, readonly StatSource[]>();
    for (const call of raw.fetch as readonly unknown[]) {
        assert.ok(typeof call === 'object' && call !== null && 'ids' in call && 'json' in call && Array.isArray(call.ids));
        const ids: string[] = call.ids.filter((id: unknown): id is string => typeof id === 'string');
        for (const l of readFetchResponse(call.json, ids).listings) {
            out.set(l.id, l.statSources);
        }
    }
    return out;
}

test(
    'a listing with an excluded hybrid is dropped before scoring, counted per mod and noted per band (#38)',
    { skip: existsSync(V19_FILE) ? false : `no fixture at ${V19_FILE}` },
    async () => {
        const sources: ReadonlyMap<string, readonly StatSource[]> = v19Sources();
        const of = (id: string): readonly StatSource[] => {
            const s: readonly StatSource[] | undefined = sources.get(id);
            assert.ok(s, `no listing ${id}`);
            return s;
        };
        const name: string = '+# to maximum Energy Shield / +# to maximum Mana';
        const withHybrid: SlotSearchSpec = {
            ...spec(300),
            modExclusions: [
                {
                    statIds: ['explicit.stat_1050105434', 'explicit.stat_4052037485'],
                    name: name,
                    origin: 'plan',
                    label: `Excluded: ${name} (hybrid mod), from plan`,
                },
            ],
        };
        const trade: FakeTrade = new FakeTrade(
            new Map<string, readonly TradeListing[]>([
                [
                    'chaos:300',
                    [
                        listing('deacon', 150, 'chaos', 6, {
                            statSources: of('2ec94c022cec19007a9031a7c507b3f591e24204df096f23d1d4d1263b101449'),
                        }),
                        listing('separate', 160, 'chaos', 3, {
                            statSources: of('fc82c25153028551d41adcbb769d5c2b4245fdff6888d12bcc74b3a0e3910e43'),
                        }),
                        listing('plain', 170, 'chaos', 2),
                    ],
                ],
            ]),
        );
        const scoredTexts: string[] = [];
        const tracing: RunEngine = {
            score(texts: readonly string[], onItem: (result: EngineScore) => void): Promise<void> {
                scoredTexts.push(...texts);
                return fakeEngine.score(texts, onItem);
            },
        };
        const events: RunEvent[] = [];
        const input = { league: 'Covens', spec: withHybrid, baseline: baseStats(), blend: 0.5, depth: 100, chaosPerDivine: RATE };
        const result: RunResult = await runSlotSearch(input, trade, tracing, (e: RunEvent) => {
            events.push(e);
        });
        // The hybrid boot never reaches PoB; the one with both stats from other mods is scored.
        assert.equal(
            scoredTexts.some((t: string) => t.includes('deacon')),
            false,
        );
        assert.deepEqual(result.items.map((f) => f.evaluated.item.id).sort(), ['plain', 'separate']);
        assert.equal(result.counts.scored, 2);
        assert.equal(result.counts.skippedBy['excluded-mod'], 1);
        assert.deepEqual(result.counts.excludedMods, [{ name: name, dropped: 1 }]);
        assert.ok(events.some((e: RunEvent) => e.kind === 'skipped' && e.listingId === 'deacon' && e.reason === 'excluded-mod'));
        const notes: string[] = events.flatMap((e: RunEvent) => (e.kind === 'note' ? [e.message] : []));
        assert.equal(notes.length, 1);
        assert.ok((notes[0] ?? '').endsWith(`: 1 listing dropped for an excluded mod (${name}).`), `note: ${notes[0] ?? 'none'}`);
        // A deeper pass carries the counts over.
        const deeper: RunResult = await deepenSlotSearch(input, result, trade, tracing, () => undefined);
        assert.deepEqual(deeper.counts.excludedMods, [{ name: name, dropped: 1 }]);
    },
);

test('an empty run hands what narrowed it, and the over-budget count, to the verdict (#34)', async () => {
    const trade: FakeTrade = new FakeTrade(new Map<string, readonly TradeListing[]>([['chaos:375', [listing('over', 350, 'chaos', 1)]]]));
    const result: RunResult = await runSlotSearch(
        {
            league: 'Covens',
            spec: spec(300),
            baseline: baseStats(),
            blend: 0.5,
            depth: 100,
            chaosPerDivine: undefined,
            emptyCauses: ['Links ≥ 6'],
        },
        trade,
        fakeEngine,
        () => undefined,
    );
    assert.equal(
        result.verdict.note,
        'No upgrade found: no listings in budget matched the search. 1 listing just over budget did. What narrowed it: Links ≥ 6. ' +
            'Try a bigger budget, or loosening one of these.',
    );
});
