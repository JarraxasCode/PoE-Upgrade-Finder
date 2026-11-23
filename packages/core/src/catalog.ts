// ModCatalog (PLAN.md, Search spec, "What v1 must build"): names trade stats for people. v1 is backed by the
// trade site's stat list; v0.2 adds per-slot mod lists from PoB's data (the engine's slotData, Phase 6).

import type { SlotData, SlotFamily, SlotInfluence, SlotMod } from '@poe-upgrade-finder/engine-client';
import type { TradeStatEntry } from '@poe-upgrade-finder/trade';
import type { SlotId } from './spec.ts';

/** One tier of a mod that can roll on the chosen base(s). */
export interface SlotTier {
    readonly modId: string;
    readonly mod: SlotMod;
}

/** One mod family that can roll on the chosen base(s): its tiers there and the bases that roll it. */
export interface SlotModChoice {
    /** Index into SlotData.families: the family's id within one slot data set. */
    readonly familyIndex: number;
    readonly family: SlotFamily;
    /** The pool it comes from: `none` for plain mods, else the influence that adds it. */
    readonly influence: SlotInfluence;
    /** Tiers that can roll on at least one chosen base, lowest item level first. */
    readonly tiers: readonly SlotTier[];
    /** PoB names of the chosen bases that can roll at least one tier. */
    readonly bases: readonly string[];
}

export class ModCatalog {
    private readonly byId: ReadonlyMap<string, TradeStatEntry>;
    private readonly entries: readonly TradeStatEntry[];
    private readonly slotData: ReadonlyMap<string, SlotData>;
    /** Each id's place in the site's list within its type (explicit, implicit, crafted...): the site's own order. */
    private readonly ranks: ReadonlyMap<string, number>;

    public constructor(entries: readonly TradeStatEntry[], slotData: readonly SlotData[] = []) {
        this.entries = entries;
        this.byId = new Map<string, TradeStatEntry>(entries.map((e: TradeStatEntry) => [e.id, e]));
        const counts: Map<string, number> = new Map<string, number>();
        const ranks: Map<string, number> = new Map<string, number>();
        for (const e of entries) {
            const n: number = counts.get(e.type) ?? 0;
            counts.set(e.type, n + 1);
            if (!ranks.has(e.id)) {
                ranks.set(e.id, n);
            }
        }
        this.ranks = ranks;
        this.slotData = new Map<string, SlotData>(slotData.map((d: SlotData) => [d.baseType, d]));
    }

    public get size(): number {
        return this.entries.length;
    }

    /** A catalog with this base type's slot data added (or replaced). */
    public withSlotData(data: SlotData): ModCatalog {
        const all: SlotData[] = [...this.slotData.values()].filter((d: SlotData) => d.baseType !== data.baseType);
        all.push(data);
        return new ModCatalog(this.entries, all);
    }

    /** The slot data for a PoB base type ("Boots"), if added. */
    public slotDataFor(baseType: string): SlotData | undefined {
        return this.slotData.get(baseType);
    }

    /**
     * Where a stat sits in the site's list among its own type (0 = first). The site lists stats most used
     * first, so this is its dropdown order; undefined when the id isn't in the list.
     */
    public rank(statId: string): number | undefined {
        return this.ranks.get(statId);
    }

    /** The site's pseudo stats, in its order (the slot plan's Totals list, issue #26). */
    public pseudoStats(): readonly TradeStatEntry[] {
        return this.entries.filter((e: TradeStatEntry) => e.type === 'pseudo');
    }

    /** "+# to maximum Life", with the type when it isn't a plain explicit ("(pseudo) +# total maximum Life"); undefined when unknown. */
    public describe(statId: string): string | undefined {
        const e: TradeStatEntry | undefined = this.byId.get(statId);
        if (e === undefined) {
            return undefined;
        }
        return e.type === 'explicit' ? e.text : `(${e.type}) ${e.text}`;
    }

    /** v1: the whole list (the trade site's list isn't per slot). Per-base lists come from slotMods. */
    public modsForSlot(_slot: SlotId): readonly TradeStatEntry[] {
        return this.entries;
    }

    /**
     * The mod families that can roll on a base (PoB's name), or on any base of the type when `baseName` is
     * null, from the plain pool and each influence asked for. A family shows once per pool it comes from,
     * with only the tiers that can roll there. Sorted by type, then text. Empty when the base type's slot data
     * isn't added or the base is unknown.
     */
    public slotMods(baseType: string, baseName: string | null, influences: readonly SlotInfluence[] = []): readonly SlotModChoice[] {
        const data: SlotData | undefined = this.slotData.get(baseType);
        if (data === undefined) {
            return [];
        }
        const bases = data.bases.filter((b) => baseName === null || b.name === baseName);
        const pools: readonly SlotInfluence[] = ['none', ...influences.filter((i: SlotInfluence) => i !== 'none')];
        // key "<influence>|<family>" -> tiers (mod id -> base names)
        const found: Map<string, { influence: SlotInfluence; family: number; tiers: Map<string, Set<string>> }> = new Map();
        for (const base of bases) {
            for (const influence of pools) {
                const pool: number | undefined = base.pools[influence];
                const ids: readonly string[] = pool === undefined ? [] : (data.pools[pool] ?? []);
                for (const modId of ids) {
                    const mod: SlotMod | undefined = data.mods[modId];
                    if (mod === undefined) {
                        continue;
                    }
                    const key: string = `${influence}|${mod.family}`;
                    let entry = found.get(key);
                    if (entry === undefined) {
                        entry = { influence: influence, family: mod.family, tiers: new Map<string, Set<string>>() };
                        found.set(key, entry);
                    }
                    let names: Set<string> | undefined = entry.tiers.get(modId);
                    if (names === undefined) {
                        names = new Set<string>();
                        entry.tiers.set(modId, names);
                    }
                    names.add(base.name);
                }
            }
        }
        const choices: SlotModChoice[] = [];
        for (const entry of found.values()) {
            const family: SlotFamily | undefined = data.families[entry.family];
            if (family === undefined) {
                continue;
            }
            const order: ReadonlyMap<string, number> = new Map(family.tiers.map((t: string, i: number) => [t, i]));
            const tierIds: string[] = [...entry.tiers.keys()].sort((a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
            const baseNames: Set<string> = new Set<string>();
            for (const names of entry.tiers.values()) {
                for (const n of names) {
                    baseNames.add(n);
                }
            }
            choices.push({
                familyIndex: entry.family,
                family: family,
                influence: entry.influence,
                tiers: tierIds.flatMap((modId: string) => {
                    const mod: SlotMod | undefined = data.mods[modId];
                    return mod === undefined ? [] : [{ modId: modId, mod: mod }];
                }),
                bases: [...baseNames].sort(),
            });
        }
        return choices.sort(
            (a: SlotModChoice, b: SlotModChoice) =>
                a.family.type.localeCompare(b.family.type) ||
                a.family.text.localeCompare(b.family.text) ||
                a.influence.localeCompare(b.influence),
        );
    }
}
