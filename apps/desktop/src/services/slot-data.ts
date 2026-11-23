// PoB's slot data for the slot plan (PLAN.md, Phase 6): per item type, from cache.sqlite (per PoB version), else
// from the engine (1 to 5 s, no build needed) and cached. Plus the editor's view of it (`slot.data`).
//
// The engine call takes the worker lock (EngineSession.exclusive, in `fetch`): never call get() from inside
// another exclusive task, it would wait on itself.

import { ModCatalog, PSEUDO_TOTALS } from '@poe-upgrade-finder/core';
import type { PseudoTotal, SlotModChoice, SlotTier } from '@poe-upgrade-finder/core';
import type { SlotBase, SlotData, SlotFamily, SlotImplicit, SlotModStat, WithWarnings } from '@poe-upgrade-finder/engine-client';
import { SLOT_INFLUENCES } from '@poe-upgrade-finder/ipc';
import type { BaseOption, GearSlot, ModOption, ModPosition, SlotEditorData, StatOption, TotalOption } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import type { TradeStatEntry } from '@poe-upgrade-finder/trade';
import { baseArt } from './base-art.ts';
import { UserFacingError } from '../ui/user-facing-error.ts';

export interface SlotDataCache {
    slotData(pobVersion: string, baseType: string): SlotData | undefined;
    saveSlotData(data: SlotData): void;
}

export interface SlotDataServiceOptions {
    readonly cache: SlotDataCache;
    /** The live PoB copy's version (its manifest), the cache key; null when unknown (then always asks the engine). */
    readonly pobVersion: () => string | null;
    /** The engine's slotData for an item type, under the worker lock. */
    readonly fetch: (itemType: string) => Promise<WithWarnings<SlotData>>;
    readonly logger: Logger;
}

export class SlotDataService {
    private readonly options: SlotDataServiceOptions;
    /** In flight or done, per PoB version and item type: one engine call each. */
    private readonly pending: Map<string, Promise<SlotData>> = new Map<string, Promise<SlotData>>();

    public constructor(options: SlotDataServiceOptions) {
        this.options = options;
    }

    /** The slot data for a PoB item type ("Boots"). */
    public get(itemType: string): Promise<SlotData> {
        const version: string | null = this.options.pobVersion();
        const key: string = `${version ?? '?'}|${itemType}`;
        const known: Promise<SlotData> | undefined = this.pending.get(key);
        if (known !== undefined) {
            return known;
        }
        const work: Promise<SlotData> = this.load(version, itemType);
        this.pending.set(key, work);
        work.catch(() => {
            // A failure isn't remembered: the next ask tries again.
            this.pending.delete(key);
        });
        return work;
    }

    private async load(version: string | null, itemType: string): Promise<SlotData> {
        const log: Logger = this.options.logger;
        if (version !== null) {
            const cached: SlotData | undefined = this.options.cache.slotData(version, itemType);
            if (cached !== undefined) {
                return cached;
            }
        }
        const fresh: WithWarnings<SlotData> = await this.options.fetch(itemType);
        log.log('info', 'slot data from PoB', {
            itemType: itemType,
            pobVersion: fresh.pobVersion,
            bases: fresh.bases.length,
            families: fresh.families.length,
            seconds: fresh.seconds,
            warnings: fresh.warnings.length,
        });
        const { warnings: _warnings, ...data } = fresh;
        this.options.cache.saveSlotData(data);
        return data;
    }
}

const POSITION: Readonly<Record<SlotFamily['type'], ModPosition>> = {
    Prefix: 'prefix',
    Suffix: 'suffix',
    Exarch: 'implicit',
    Eater: 'implicit',
    Corrupted: 'implicit',
};

/** A site range as the mod reads: a negated stat's [-32, -18] is "reduced 18 to 32". */
function asRead(range: readonly [number, number], negate: boolean): readonly [number, number] {
    return negate ? [-range[1], -range[0]] : range;
}

function widen(a: readonly [number, number] | null, b: readonly [number, number]): readonly [number, number] {
    return a === null ? b : [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

function familyStats(family: SlotFamily, tiers: readonly SlotTier[]): StatOption[] {
    const segments: readonly string[] = family.text.split(' / ');
    return family.tradeIds.map((statId: string, index: number): StatOption => {
        let roll: readonly [number, number] | null = null;
        let found: SlotModStat | undefined = undefined;
        let lines: number = 0;
        for (const tier of tiers) {
            const s: SlotModStat | undefined = tier.mod.stats.find((x: SlotModStat) => x.id === statId);
            if (s === undefined) {
                continue;
            }
            found ??= s;
            lines = tier.mod.lines.length;
            if (s.range !== undefined) {
                roll = widen(roll, asRead(s.range, s.negate));
            }
        }
        const siteText: string = family.siteTexts[index] ?? found?.text ?? statId;
        const line: string | undefined = found?.line === undefined || segments.length !== lines ? undefined : segments[found.line];
        return { statId: statId, text: line ?? siteText, siteText: siteText, negate: found?.negate ?? false, roll: roll };
    });
}

function implicitStats(implicit: SlotImplicit): StatOption[] {
    return implicit.stats.map((s: SlotModStat): StatOption => ({
        statId: s.id,
        text: s.text,
        siteText: s.text,
        negate: s.negate,
        roll: s.range === undefined ? null : asRead(s.range, s.negate),
    }));
}

function baseOption(base: SlotBase): BaseOption {
    return {
        name: base.name,
        tradeType: base.tradeType,
        level: base.level,
        defences: base.defences,
        implicits: base.implicits.map((imp: SlotImplicit) => ({ lines: imp.lines, stats: implicitStats(imp) })),
        influences: SLOT_INFLUENCES.filter((i) => i !== 'none' && base.pools[i] !== undefined),
        icon: baseArt(base.tradeType)?.icon ?? baseArt(base.name)?.icon ?? null,
    };
}

/** The best (lowest) site rank among a mod's stats, or null when none is in the site's list. */
function bestRank(ids: readonly string[], rankOf: (statId: string) => number | undefined): number | null {
    let best: number | null = null;
    for (const id of ids) {
        const r: number | undefined = rankOf(id);
        if (r !== undefined && (best === null || r < best)) {
            best = r;
        }
    }
    return best;
}

/** The editor's data for one base (or any base of the type): every base, and every mod that can roll, in every pool. */
export function slotEditorData(
    data: SlotData,
    slot: GearSlot,
    base: string | null,
    pseudoStats: readonly TradeStatEntry[] = [],
    /** A stat's place in the trade site's list (ModCatalog.rank), for the site's order in the editor. */
    rankOf: (statId: string) => number | undefined = () => undefined,
): SlotEditorData {
    if (base !== null && !data.bases.some((b: SlotBase) => b.name === base)) {
        throw new UserFacingError(`${base} isn't a ${data.baseType} base in PoB ${data.pobVersion}.`);
    }
    const catalog: ModCatalog = new ModCatalog([], [data]);
    const choices: readonly SlotModChoice[] = catalog.slotMods(
        data.baseType,
        base,
        SLOT_INFLUENCES.filter((i) => i !== 'none'),
    );
    const mods: ModOption[] = choices.map((c: SlotModChoice): ModOption => ({
        position: POSITION[c.family.type],
        type: c.family.type,
        group: c.family.group,
        influence: c.influence,
        source: c.family.source,
        rank: bestRank(c.family.tradeIds, rankOf),
        text: c.family.text,
        stats: familyStats(c.family, c.tiers),
        tiers: c.tiers.map((t: SlotTier) => ({ level: t.mod.level, lines: t.mod.lines })),
        bases: c.bases,
    }));
    return {
        pobVersion: data.pobVersion,
        slot: slot,
        itemType: data.baseType,
        base: base,
        bases: data.bases.map(baseOption),
        mods: mods,
        totals: totalOptions(pseudoStats),
    };
}

const PSEUDO_ID: RegExp = /^pseudo\.pseudo_[a-z0-9_]{1,100}$/;

/**
 * The site's pseudo stats that are about gear, by id prefix: an allow-list, so a new league's mechanic stays out.
 * The rest of the site's list is maps, Incursion temple rooms, logbooks, Ritual vessels, Heist reflections and
 * cluster-jewel notables.
 */
const GEAR_PSEUDO: RegExp =
    /^pseudo\.pseudo_(?:total_|count_|increased_|global_|critical_|adds_|percent_|physical_attack_|number_of_(?!notable)|searing_|tangled_|base_defence_|has_|jewellery_)/;

/** Whether a site pseudo stat is about gear (the Totals list shows only these). */
export function isGearPseudo(id: string): boolean {
    return PSEUDO_ID.test(id) && GEAR_PSEUDO.test(id);
}

/**
 * The totals a plan can require (issue #26): the gear pseudo stats on the trade site's list, the ones V27
 * measured first (with what counts towards them), then the rest in the site's order. Without the list, the
 * measured ones.
 */
export function totalOptions(pseudoStats: readonly TradeStatEntry[]): TotalOption[] {
    const known: ReadonlyMap<string, PseudoTotal> = new Map<string, PseudoTotal>(PSEUDO_TOTALS.map((p: PseudoTotal) => [p.id, p]));
    const site: readonly TradeStatEntry[] = pseudoStats.filter((e: TradeStatEntry) => e.type === 'pseudo' && isGearPseudo(e.id));
    const siteText: ReadonlyMap<string, string> = new Map<string, string>(site.map((e: TradeStatEntry) => [e.id, e.text]));
    const measured: TotalOption[] = PSEUDO_TOTALS.map((p: PseudoTotal): TotalOption => ({
        id: p.id,
        text: siteText.get(p.id) ?? p.text,
        counts: p.counts,
    }));
    const rest: TotalOption[] = site
        .filter((e: TradeStatEntry) => !known.has(e.id))
        .map((e: TradeStatEntry): TotalOption => ({ id: e.id, text: e.text, counts: null }));
    return [...measured, ...rest];
}
