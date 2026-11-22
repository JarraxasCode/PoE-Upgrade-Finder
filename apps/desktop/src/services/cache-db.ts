// The app's small cache (PLAN.md, Data, settings & storage): one SQLite file, <userData>/cache.sqlite, through
// Node's built-in node:sqlite (no package). It holds things that are cheap to lose and quick to rebuild:
//   - divine_rate: the last rate per league (GGG's hour or a typed one), replacing divine-rate.json;
//   - trade_stats: the trade site's stat list for ModCatalog (refreshed after a week);
//   - generator: PoB's trade query per build file, slot, damage target, blend and PoB version (V23: PoB's
//     generator weights vary from worker to worker, so v1 caches one result and reuses it).
// Every row is checked when read; a bad row is deleted and treated as missing.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { readTradeQuery } from '@poe-upgrade-finder/engine-client';
import type { TargetRequest, TradeQueryData } from '@poe-upgrade-finder/engine-client';
import { readStatList } from '@poe-upgrade-finder/trade';
import type { DivineRate, RateStore, TradeStatEntry } from '@poe-upgrade-finder/trade';
import { array, isRecord } from '@poe-upgrade-finder/validate';
import { readEquippedInfo } from '@poe-upgrade-finder/ipc';
import type { EquippedInfo } from '@poe-upgrade-finder/ipc';

const SCHEMA_VERSION: number = 3;
/** Builds whose gear is remembered. */
const EQUIPPED_KEEP: number = 50;
/** Generator rows kept (newest first); older ones are pruned on write. */
const GENERATOR_KEEP: number = 200;

export interface GeneratorKey {
    /** sha1 of the save's text (LoadedBuild.xmlHash): any edit in PoB is a new key. */
    readonly xmlHash: string;
    readonly slot: string;
    readonly target: TargetRequest;
    readonly blend: number;
    readonly pobVersion: string;
}

/**
 * Bumped when what the generator runs on changes without the PoB version changing. 2: QueryMods.lua is now
 * rebuilt with PoB's own code (Phase 5), so weights cached from PoB's shipped table are dropped.
 */
const GENERATOR_DATA: number = 2;

export function generatorKey(key: GeneratorKey): string {
    const text: string = JSON.stringify([key.xmlHash, key.slot, key.target, key.blend, key.pobVersion, GENERATOR_DATA]);
    return createHash('sha256').update(text).digest('hex');
}

function readRate(value: unknown): DivineRate | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const { chaosPerDivine, source, hour, at } = value;
    if (typeof chaosPerDivine !== 'number' || !(chaosPerDivine > 0) || (source !== 'ggg' && source !== 'manual') || typeof at !== 'number') {
        return undefined;
    }
    return { chaosPerDivine: chaosPerDivine, source: source, hour: typeof hour === 'number' ? hour : undefined, at: at };
}

function parseJson(text: unknown): unknown {
    if (typeof text !== 'string') {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export class CacheDb {
    private readonly db: DatabaseSync;

    /** path: a file, or ':memory:' in tests. */
    public constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.migrate();
    }

    public close(): void {
        this.db.close();
    }

    /** The divine-rate store for DivineRateClient. */
    public rateStore(): RateStore {
        const get: StatementSync = this.db.prepare('SELECT value FROM divine_rate WHERE league = ?');
        const put: StatementSync = this.db.prepare('INSERT INTO divine_rate (league, value) VALUES (?, ?) ON CONFLICT(league) DO UPDATE SET value = excluded.value');
        const del: StatementSync = this.db.prepare('DELETE FROM divine_rate WHERE league = ?');
        return {
            get: (league: string): DivineRate | undefined => {
                const row: unknown = get.get(league);
                if (row === undefined) {
                    return undefined;
                }
                const rate: DivineRate | undefined = readRate(parseJson(isRecord(row) ? row['value'] : undefined));
                if (rate === undefined) {
                    del.run(league);
                }
                return rate;
            },
            set: (league: string, rate: DivineRate): void => {
                put.run(league, JSON.stringify(rate));
            },
            delete: (league: string): void => {
                del.run(league);
            },
        };
    }

    /** PoB's trade query for this build, slot, target and blend, if generated before. */
    public generator(key: string): TradeQueryData | undefined {
        const row: unknown = this.db.prepare('SELECT value FROM generator WHERE key = ?').get(key);
        if (row === undefined) {
            return undefined;
        }
        try {
            return readTradeQuery(parseJson(isRecord(row) ? row['value'] : undefined));
        } catch {
            this.db.prepare('DELETE FROM generator WHERE key = ?').run(key);
            return undefined;
        }
    }

    public saveGenerator(key: string, data: TradeQueryData): void {
        // Stored in the engine's own shape (query is the raw object), so readTradeQuery reads it back.
        const value: string = JSON.stringify({ ...data, query: data.query.raw });
        this.db.prepare('INSERT INTO generator (key, value, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at')
            .run(key, value, Date.now());
        this.db.prepare('DELETE FROM generator WHERE key NOT IN (SELECT key FROM generator ORDER BY created_at DESC LIMIT ?)').run(GENERATOR_KEEP);
    }

    /** The cached stat list and when it was fetched; undefined when there is none or it doesn't read. */
    public statList(): { readonly entries: TradeStatEntry[]; readonly fetchedAt: number } | undefined {
        const row: unknown = this.db.prepare("SELECT value, fetched_at FROM trade_stats WHERE key = 'stats'").get();
        if (!isRecord(row)) {
            return undefined;
        }
        try {
            return { entries: readStatList(parseJson(row['value'])), fetchedAt: Number(row['fetched_at']) };
        } catch {
            this.db.exec('DELETE FROM trade_stats');
            return undefined;
        }
    }

    public saveStatList(entries: readonly TradeStatEntry[], fetchedAt: number): void {
        // Stored in the site's own shape so readStatList reads it back.
        const value: string = JSON.stringify({ result: [{ entries: entries }] });
        this.db.prepare("INSERT INTO trade_stats (key, value, fetched_at) VALUES ('stats', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at")
            .run(value, fetchedAt);
    }

/** The gear PoB last reported for a build, to show while it loads again (images appear at once). */
    public equipped(buildId: string): readonly EquippedInfo[] | undefined {
        const row: unknown = this.db.prepare('SELECT value FROM equipped WHERE build_id = ?').get(buildId);
        if (!isRecord(row)) {
            return undefined;
        }
        try {
            return array(parseJson(row['value']), 'equipped', readEquippedInfo);
        } catch {
            this.db.prepare('DELETE FROM equipped WHERE build_id = ?').run(buildId);
            return undefined;
        }
    }

    public saveEquipped(buildId: string, items: readonly EquippedInfo[]): void {
        this.db.prepare('INSERT INTO equipped (build_id, value, saved_at) VALUES (?, ?, ?) ON CONFLICT(build_id) DO UPDATE SET value = excluded.value, saved_at = excluded.saved_at')
            .run(buildId, JSON.stringify(items), Date.now());
        this.db.prepare('DELETE FROM equipped WHERE build_id NOT IN (SELECT build_id FROM equipped ORDER BY saved_at DESC LIMIT ?)').run(EQUIPPED_KEEP);
    }

    /** Forgets every cached generator result (Settings, or after a PoB update). */
    public clearGenerator(): number {
        return Number(this.db.prepare('DELETE FROM generator').run().changes);
    }

    private migrate(): void {
        this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        const row: unknown = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
        const version: number = isRecord(row) ? Number(row['value']) : 0;
        if (version >= SCHEMA_VERSION) {
            return;
        }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS divine_rate (league TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS generator (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS trade_stats (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS equipped (build_id TEXT PRIMARY KEY, value TEXT NOT NULL, saved_at INTEGER NOT NULL);
        `);
        this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
    }
}
