// The uniques a slot can take (#113): PoB's unique list for the item type, each scored in the build and weighted
// by its own rolls (engine `uniques`), cached per save, slot, item type, target and blend like PoB's generator
// weights. The Search view's picker reads `list`; a unique run reads `uniquesFor` inside its own worker lock.
//
// `list` takes the lock itself, so never call it from inside another exclusive task: it would wait on itself.

import { generatorWeights } from '@poe-upgrade-finder/core';
import type { ModCatalog } from '@poe-upgrade-finder/core';
import type { TargetRequest, UniqueInfo, UniquesData, UniquesOptions, UniqueWeight, WithWarnings } from '@poe-upgrade-finder/engine-client';
import type { SearchedStat, UiUnique, UniqueList } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import type { GearSlot } from '@poe-upgrade-finder/vocab';
import { UserFacingError } from '../ui/user-facing-error.ts';
import { targetRequest } from './build-summary.ts';
import { uniquesKey } from './cache-db.ts';
import { readSave } from './engine-session.ts';
import type { WeightBuild } from './weights.ts';

/** The cache rows the service reads and writes (CacheDb). */
export interface UniqueCache {
    uniques(key: string): UniquesData | undefined;
    saveUniques(key: string, data: UniquesData): void;
}

/** The engine call the service makes (EngineClient). */
export interface UniqueEngine {
    uniques(slot: GearSlot, itemType: string, options?: UniquesOptions): Promise<WithWarnings<UniquesData>>;
}

/** The parts of EngineSession the service uses. */
export interface UniqueSession {
    readonly loaded: WeightBuild | undefined;
    ensure(buildId: string, file: string, targetId: string): Promise<WeightBuild>;
    exclusive<T>(task: (client: UniqueEngine) => Promise<T>): Promise<T>;
    /** The PoB version the worker will report, without starting it; null when unknown. */
    expectedPobVersion(): string | null;
}

export interface UniqueRequest {
    readonly slot: GearSlot;
    readonly itemType: string;
    readonly target: TargetRequest;
    /** DPS against EHP (BuildSettings.blend), as for PoB's generator. */
    readonly blend: number;
}

export interface UniqueServiceOptions {
    readonly cache: UniqueCache;
    readonly session: UniqueSession;
    /** The save's full path for a build id, or undefined when it isn't in the Builds folder. */
    readonly buildFile: (buildId: string) => string | undefined;
    readonly blend: (buildId: string) => number;
    /** Names for the trade stats (the site's stat list), when known. */
    readonly catalog: () => Promise<ModCatalog | undefined>;
    readonly logger: Logger;
}

export class UniqueService {
    private readonly options: UniqueServiceOptions;

    public constructor(options: UniqueServiceOptions) {
        this.options = options;
    }

    /** The uniques for the loaded build, under a worker lock the caller holds: from the cache, else listed and cached. */
    public async uniquesFor(
        client: UniqueEngine,
        loaded: WeightBuild,
        request: UniqueRequest,
    ): Promise<{ readonly data: UniquesData; readonly cached: boolean }> {
        const key: string = this.keyFor(loaded.xmlHash, loaded.load.pobVersion, request);
        const cached: UniquesData | undefined = this.options.cache.uniques(key);
        if (cached !== undefined) {
            this.options.logger.log('info', 'uniques from the cache', { key: key });
            return { data: cached, cached: true };
        }
        const fresh: WithWarnings<UniquesData> = await client.uniques(request.slot, request.itemType, {
            target: request.target,
            ...generatorWeights(request.blend),
        });
        const { warnings, ...result } = fresh;
        this.options.cache.saveUniques(key, result);
        this.options.logger.log('info', 'uniques listed', { key: key, uniques: result.uniques.length, warnings: warnings.length });
        return { data: result, cached: false };
    }

    /** The picker's list for a build, slot, target and item type: best estimated change first, weights named. */
    public async list(buildId: string, slot: GearSlot, targetId: string, itemType: string): Promise<UniqueList> {
        const file: string | undefined = this.options.buildFile(buildId);
        if (file === undefined) {
            throw new UserFacingError(`That build isn't in the Builds folder any more: ${buildId}`);
        }
        const request: UniqueRequest = {
            slot: slot,
            itemType: itemType,
            target: targetRequest(targetId),
            blend: this.options.blend(buildId),
        };
        const result = this.fromCacheBeforeLoad(file, request) ?? (await this.afterLoad(buildId, file, targetId, request));
        const catalog: ModCatalog | undefined = await this.options.catalog();
        const label = (statId: string): string => catalog?.describe(statId) ?? statId;
        const uniques: UiUnique[] = [...result.data.uniques]
            .sort((a: UniqueInfo, b: UniqueInfo) => b.change - a.change || a.name.localeCompare(b.name))
            .map((u: UniqueInfo) => ({
                name: u.name,
                base: u.base,
                tradeType: u.tradeType,
                change: u.change,
                // Against the equipped item's own score (scoreHigh − change); 0 when that score is 0.
                changePct: u.scoreHigh - u.change === 0 ? 0 : (u.change / (u.scoreHigh - u.change)) * 100,
                weights: [...u.weights]
                    .sort((a: UniqueWeight, b: UniqueWeight) => Math.abs(b.weight) - Math.abs(a.weight))
                    .map((w: UniqueWeight): SearchedStat => ({ statId: w.id, label: label(w.id), weight: w.weight })),
                foulborn: u.foulborn?.modId ?? null,
                foulbornLine: u.foulborn?.line ?? null,
            }));
        return { buildId: buildId, slot: slot, target: targetId, itemType: itemType, cached: result.cached, uniques: uniques };
    }

    private keyFor(xmlHash: string, pobVersion: string, request: UniqueRequest): string {
        return uniquesKey({
            xmlHash: xmlHash,
            slot: request.slot,
            itemType: request.itemType,
            target: request.target,
            blend: request.blend,
            pobVersion: pobVersion,
        });
    }

    private fromCacheBeforeLoad(
        file: string,
        request: UniqueRequest,
    ): { readonly data: UniquesData; readonly cached: boolean } | undefined {
        const pobVersion: string | null = this.options.session.expectedPobVersion();
        if (pobVersion === null) {
            return undefined;
        }
        let xmlHash: string;
        try {
            xmlHash = readSave(file).xmlHash;
        } catch {
            return undefined;
        }
        const cached: UniquesData | undefined = this.options.cache.uniques(this.keyFor(xmlHash, pobVersion, request));
        return cached === undefined ? undefined : { data: cached, cached: true };
    }

    private async afterLoad(
        buildId: string,
        file: string,
        targetId: string,
        request: UniqueRequest,
    ): Promise<{ readonly data: UniquesData; readonly cached: boolean }> {
        const { session } = this.options;
        const loaded: WeightBuild = await session.ensure(buildId, file, targetId);
        return session.exclusive((client: UniqueEngine) => {
            // Another build can load between ensure() and the lock (as in WeightService).
            if (session.loaded !== loaded) {
                throw new UserFacingError('The build changed while the uniques were loading: pick it again.');
            }
            return this.uniquesFor(client, loaded, request);
        });
    }
}
