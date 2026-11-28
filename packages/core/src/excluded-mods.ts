// Excluded hybrid mods (#38, G19): the trade site filters stats, never mods, so a hybrid exclude can't be a Not
// group (that drops every item with either stat). A fetched listing names the mod behind each stat line instead:
// item.extended.hashes lists, per domain, each line's mod indices, and a hybrid's stats share one index in one
// domain. A crafted or fractured copy of the mod is the same mod (V24, decision 9), so those domains count too;
// index 0 under explicit and index 0 under crafted are different mods.

import type { StatLineKind, StatSource } from '@poe-upgrade-finder/trade';
import type { SearchModExclusion } from './spec.ts';

/** The domains an explicit mod can sit in on a listed item. */
const MOD_DOMAINS: readonly StatLineKind[] = ['explicit', 'crafted', 'fractured'];

/** "explicit.stat_X" and "crafted.stat_X" → "stat_X". */
function bareStat(statId: string): string {
    return statId.slice(statId.indexOf('.') + 1);
}

/** The domain in which one mod carries every one of the stats, or undefined when no single mod does. */
export function modDomain(statIds: readonly string[], sources: readonly StatSource[]): StatLineKind | undefined {
    if (statIds.length === 0) {
        return undefined;
    }
    const wanted: readonly string[] = statIds.map(bareStat);
    for (const domain of MOD_DOMAINS) {
        const byMod: Map<number, Set<string>> = new Map<number, Set<string>>();
        for (const s of sources) {
            if (s.kind !== domain) {
                continue;
            }
            for (const mod of s.mods) {
                const stats: Set<string> = byMod.get(mod) ?? new Set<string>();
                stats.add(bareStat(s.statId));
                byMod.set(mod, stats);
            }
        }
        for (const stats of byMod.values()) {
            if (wanted.every((w: string) => stats.has(w))) {
                return domain;
            }
        }
    }
    return undefined;
}

/** The first excluded mod the item has, or undefined (also when the listing names no mods). */
export function excludedModOf(exclusions: readonly SearchModExclusion[], sources: readonly StatSource[]): SearchModExclusion | undefined {
    return exclusions.find((e: SearchModExclusion) => modDomain(e.statIds, sources) !== undefined);
}
