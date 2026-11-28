import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readTradeQuery } from '@poe-upgrade-finder/engine-client';
import type { TradeQueryData, TradeQueryOptions, WithWarnings } from '@poe-upgrade-finder/engine-client';
import type { WeightPreview } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import type { GearSlot } from '@poe-upgrade-finder/vocab';
import { WeightService } from '../src/services/weights.ts';
import type { WeightBuild, WeightCache, WeightEngine, WeightRequest, WeightSession } from '../src/services/weights.ts';

const root: string = mkdtempSync(join(tmpdir(), 'uf-weights-'));
after(() => {
    rmSync(root, { recursive: true, force: true });
});

const quiet: Logger = {
    log(): void {
        // Tests don't read the service's log.
    },
};

const XML: string = '<PathOfBuilding><Build level="90"/></PathOfBuilding>';
const FILE: string = join(root, 'build.xml');
writeFileSync(FILE, XML);
const HASH: string = createHash('sha1').update(XML).digest('hex');

function query(over: { readonly queryError?: string } = {}): WithWarnings<TradeQueryData> {
    const data: TradeQueryData = readTradeQuery({
        slot: 'Boots',
        target: { kind: 'fullDps', saved: true },
        item: { name: 'n', base: 'b', rarity: 'RARE' },
        category: { query: 'armour.boots', generator: 'Boots' },
        statWeights: [{ stat: 'FullDPS', weight: 0.5 }],
        baseStatValue: 0,
        weights: [
            { id: 'explicit.stat_1', weight: 2, meanStatDiff: 40, invert: false },
            { id: 'explicit.stat_2', weight: 5, meanStatDiff: 40, invert: false },
        ],
        query: {
            stats: [
                {
                    type: 'weight',
                    filters: [
                        { id: 'explicit.stat_1', value: { weight: 2 } },
                        { id: 'explicit.stat_2', value: { weight: 5 } },
                    ],
                },
            ],
            filters: {},
        },
        calcs: 147,
        seconds: 1,
        log: [],
        ...(over.queryError === undefined ? {} : { queryError: over.queryError }),
    });
    return { ...data, warnings: [] };
}

class FakeCache implements WeightCache {
    public readonly rows: Map<string, TradeQueryData> = new Map<string, TradeQueryData>();
    public generator(key: string): TradeQueryData | undefined {
        return this.rows.get(key);
    }
    public saveGenerator(key: string, data: TradeQueryData): void {
        this.rows.set(key, data);
    }
}

/** The engine: counts generator runs and records what it was asked. */
class FakeEngine implements WeightEngine {
    public readonly asked: { slot: GearSlot; options: TradeQueryOptions | undefined }[] = [];
    public answer: () => WithWarnings<TradeQueryData> = () => query();
    public tradeQuery(slot: GearSlot, options?: TradeQueryOptions): Promise<WithWarnings<TradeQueryData>> {
        this.asked.push({ slot: slot, options: options });
        return Promise.resolve(this.answer());
    }
}

const BUILD: WeightBuild = { xmlHash: HASH, load: { pobVersion: '2.68.1' } };

/** One worker, one loaded build; `onEnsure` can load another build in between (the reload race). */
class FakeSession implements WeightSession {
    public loaded: WeightBuild | undefined = undefined;
    public ensured: number = 0;
    public onEnsure: () => void = () => undefined;
    public version: string | null = '2.68.1';
    public readonly engine: FakeEngine = new FakeEngine();
    public ensure(): Promise<WeightBuild> {
        this.ensured += 1;
        this.loaded = BUILD;
        const loaded: WeightBuild = BUILD;
        this.onEnsure();
        return Promise.resolve(loaded);
    }
    public exclusive<T>(task: (client: WeightEngine) => Promise<T>): Promise<T> {
        return task(this.engine);
    }
    public expectedPobVersion(): string | null {
        return this.version;
    }
}

function service(cache: WeightCache, session: WeightSession, buildFile: string | null = FILE): WeightService {
    return new WeightService({
        cache: cache,
        session: session,
        buildFile: () => buildFile ?? undefined,
        blend: () => 0.5,
        catalog: () => Promise.resolve(undefined),
        slotData: () => Promise.resolve(undefined),
        logger: quiet,
    });
}

const REQUEST: WeightRequest = { slot: 'Boots', target: { kind: 'saved' }, blend: 0.5, source: 'pob' };

test('weights: generated once with the blend, then from the cache; a query error is not cached', async () => {
    const cache: FakeCache = new FakeCache();
    const engine: FakeEngine = new FakeEngine();
    const weights: WeightService = service(cache, new FakeSession());

    const first = await weights.weightsFor(engine, BUILD, REQUEST);
    assert.equal(first.cached, false);
    assert.deepEqual(engine.asked, [{ slot: 'Boots', options: { target: { kind: 'saved' }, dpsWeight: 0.5, ehpWeight: 0.5 } }]);
    const again = await weights.weightsFor(engine, BUILD, REQUEST);
    assert.equal(again.cached, true);
    assert.equal(engine.asked.length, 1);
    // Another slot, blend or save is another key.
    await weights.weightsFor(engine, BUILD, { ...REQUEST, slot: 'Gloves' });
    await weights.weightsFor(engine, BUILD, { ...REQUEST, blend: 0.6 });
    await weights.weightsFor(engine, { ...BUILD, xmlHash: 'other' }, REQUEST);
    assert.equal(engine.asked.length, 4);

    engine.answer = () => query({ queryError: 'no item in slot' });
    const failed = await weights.weightsFor(engine, BUILD, { ...REQUEST, slot: 'Helmet' });
    assert.equal(failed.query.queryError, 'no item in slot');
    await weights.weightsFor(engine, BUILD, { ...REQUEST, slot: 'Helmet' });
    assert.equal(engine.asked.length, 6);
    assert.equal(cache.rows.size, 4);
});

test('preview: from the cache for the save on disk without loading it; else loads it and generates', async () => {
    const cache: FakeCache = new FakeCache();
    const session: FakeSession = new FakeSession();
    const weights: WeightService = service(cache, session);

    const fresh: WeightPreview = await weights.preview('build.xml', 'Boots', 'saved', null);
    assert.equal(fresh.cached, false);
    assert.equal(session.ensured, 1);
    // Heaviest first, named by stat id without a catalog.
    assert.deepEqual(
        fresh.weights.map((w) => [w.statId, w.weight]),
        [
            ['explicit.stat_2', 5],
            ['explicit.stat_1', 2],
        ],
    );
    assert.deepEqual([fresh.pruned, fresh.planProblems, fresh.planNotes], [[], [], []]);

    // The run's path and the preview share one key: what the run cached, the preview reads before PoB loads.
    const before: WeightPreview = await weights.preview('build.xml', 'Boots', 'saved', null);
    assert.equal(before.cached, true);
    assert.equal(session.ensured, 1);
    assert.equal(session.engine.asked.length, 1);

    // Without a known PoB version it can't build the key before the load, so it loads (and then hits the cache).
    session.version = null;
    const loaded: WeightPreview = await weights.preview('build.xml', 'Boots', 'saved', null);
    assert.equal(loaded.cached, true);
    assert.equal(session.ensured, 2);
    assert.equal(session.engine.asked.length, 1);
});

test('preview: a build that loads meanwhile, a missing save and a query error are user-facing errors', async () => {
    const session: FakeSession = new FakeSession();
    session.version = null;
    session.onEnsure = () => {
        session.loaded = { xmlHash: 'another build', load: { pobVersion: '2.68.1' } };
    };
    await assert.rejects(service(new FakeCache(), session).preview('build.xml', 'Boots', 'saved', null), /build changed while/);
    assert.equal(session.engine.asked.length, 0);

    await assert.rejects(
        service(new FakeCache(), new FakeSession(), null).preview('gone.xml', 'Boots', 'saved', null),
        /isn't in the Builds folder/,
    );

    const broken: FakeSession = new FakeSession();
    broken.engine.answer = () => query({ queryError: 'no item in slot' });
    await assert.rejects(
        service(new FakeCache(), broken).preview('build.xml', 'Boots', 'saved', null),
        /couldn't build the search for Boots: no item in slot/,
    );
});
