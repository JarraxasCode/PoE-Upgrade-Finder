import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { UniquesData, UniquesOptions, WithWarnings } from '@poe-upgrade-finder/engine-client';
import type { UniqueList } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import type { GearSlot } from '@poe-upgrade-finder/vocab';
import { UniqueService } from '../src/services/uniques.ts';
import type { UniqueCache, UniqueEngine, UniqueSession } from '../src/services/uniques.ts';
import type { WeightBuild } from '../src/services/weights.ts';

const root: string = mkdtempSync(join(tmpdir(), 'uf-uniques-'));
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
const LIFE: string = 'explicit.stat_3299347043';

function data(): UniquesData {
    const base = { variant: null, variants: 1, scoreLow: 1, scoreMid: 1, rolls: [], statIds: [], unmatched: [], foulborn: null };
    return {
        slot: 'Boots',
        itemType: 'Boots',
        target: { kind: 'fullDps', saved: true },
        uniques: [
            {
                ...base,
                name: 'Seven-League Step',
                base: 'Rawhide Boots',
                tradeType: 'Rawhide Boots',
                scoreHigh: 1,
                change: -160,
                weights: [],
            },
            {
                ...base,
                name: "Kaom's Roots",
                base: 'Titan Greaves',
                tradeType: 'Titan Greaves',
                scoreHigh: 1,
                change: -78,
                weights: [
                    { id: 'explicit.stat_9', weight: 0.1, line: 'x' },
                    { id: LIFE, weight: 0.33, line: '+(150-200) to maximum Life' },
                ],
            },
        ],
    };
}

class FakeCache implements UniqueCache {
    public readonly rows: Map<string, UniquesData> = new Map<string, UniquesData>();
    public uniques(key: string): UniquesData | undefined {
        return this.rows.get(key);
    }
    public saveUniques(key: string, value: UniquesData): void {
        this.rows.set(key, value);
    }
}

class FakeEngine implements UniqueEngine {
    public readonly asked: { slot: GearSlot; itemType: string; options: UniquesOptions | undefined }[] = [];
    public uniques(slot: GearSlot, itemType: string, options?: UniquesOptions): Promise<WithWarnings<UniquesData>> {
        this.asked.push({ slot: slot, itemType: itemType, options: options });
        return Promise.resolve({ ...data(), warnings: [] });
    }
}

const BUILD: WeightBuild = { xmlHash: HASH, load: { pobVersion: '2.68.1' } };

class FakeSession implements UniqueSession {
    public loaded: WeightBuild | undefined = undefined;
    public onEnsure: () => void = () => undefined;
    public readonly engine: FakeEngine = new FakeEngine();
    public ensure(): Promise<WeightBuild> {
        this.loaded = BUILD;
        this.onEnsure();
        return Promise.resolve(BUILD);
    }
    public exclusive<T>(task: (client: UniqueEngine) => Promise<T>): Promise<T> {
        return task(this.engine);
    }
    public expectedPobVersion(): string | null {
        return '2.68.1';
    }
}

function service(cache: UniqueCache, session: UniqueSession): UniqueService {
    return new UniqueService({
        cache: cache,
        session: session,
        buildFile: () => FILE,
        blend: () => 0.5,
        catalog: () => Promise.resolve(undefined),
        logger: quiet,
    });
}

test('list: asks PoB once, then reads the cache; best change first, weights heaviest first', async () => {
    const cache: FakeCache = new FakeCache();
    const session: FakeSession = new FakeSession();
    const first: UniqueList = await service(cache, session).list('a.xml', 'Boots', 'saved', 'Boots');
    assert.equal(first.cached, false);
    assert.deepEqual(
        first.uniques.map((u) => u.name),
        ["Kaom's Roots", 'Seven-League Step'],
    );
    assert.deepEqual(
        first.uniques[0]?.weights.map((w) => w.statId),
        [LIFE, 'explicit.stat_9'],
    );
    assert.equal(first.uniques[0]?.tradeType, 'Titan Greaves');
    // scoreHigh 1 with change -78: the equipped item scores 79.
    assert.equal(first.uniques[0]?.changePct, (-78 / 79) * 100);
    assert.equal(session.engine.asked.length, 1);
    assert.equal(session.engine.asked[0]?.itemType, 'Boots');
    const again: UniqueList = await service(cache, session).list('a.xml', 'Boots', 'saved', 'Boots');
    assert.equal(again.cached, true);
    assert.equal(session.engine.asked.length, 1);
});

test('list: refuses when another build loads between the load and the lock', async () => {
    const session: FakeSession = new FakeSession();
    session.onEnsure = () => {
        session.loaded = { xmlHash: 'other', load: { pobVersion: '2.68.1' } };
    };
    await assert.rejects(service(new FakeCache(), session).list('a.xml', 'Boots', 'saved', 'Boots'), /build changed/);
});
