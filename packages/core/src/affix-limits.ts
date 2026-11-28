// How many prefixes and suffixes a base allows, and how much its implicits raise their values (issue #37).
// An item has 3 prefixes and 3 suffixes, but some bases change that through their implicits (PoB 2.68.1,
// Data/Bases/ring.lua and amulet.lua), for example:
//   Ratcheting Ring  "-3 Prefix Modifiers allowed", "+3 Suffix Modifiers allowed"            0 / 6
//   Helical Ring     "-2 Prefix Modifiers allowed", "+1 Suffix Modifier allowed",
//                    "50% increased Suffix Modifier magnitudes"                               1 / 4
//   Simplex Amulet   "-2 Prefix Modifiers allowed", "-1 Suffix Modifier allowed",
//                    "100% increased Explicit Modifier magnitudes"                            1 / 2
// The lines are read from the base's implicits in the slot data, as PoB words them.

import type { SlotBase, SlotImplicit } from '@poe-upgrade-finder/engine-client';
import { PLAIN_AFFIXES } from '@poe-upgrade-finder/vocab';
import type { AffixLimits, BaseAffixes } from '@poe-upgrade-finder/vocab';

const ALLOWED: RegExp = /^([+-]\d+) (Prefix|Suffix) Modifiers? allowed$/;
const MAGNITUDES: RegExp = /^(\d+)% increased (Prefix|Suffix|Explicit) Modifier magnitudes$/;

/** One base's affix limits and magnitude bonuses, from its implicit lines. */
export function baseAffixes(base: Pick<SlotBase, 'implicits'>): BaseAffixes {
    let prefix: number = PLAIN_AFFIXES.limits.prefix;
    let suffix: number = PLAIN_AFFIXES.limits.suffix;
    let prefixMagnitude: number = 0;
    let suffixMagnitude: number = 0;
    for (const line of base.implicits.flatMap((imp: SlotImplicit) => imp.lines)) {
        const allowed: RegExpExecArray | null = ALLOWED.exec(line.trim());
        if (allowed !== null) {
            const change: number = Number(allowed[1]);
            if (allowed[2] === 'Prefix') {
                prefix += change;
            } else {
                suffix += change;
            }
            continue;
        }
        const magnitude: RegExpExecArray | null = MAGNITUDES.exec(line.trim());
        if (magnitude !== null) {
            const pct: number = Number(magnitude[1]);
            if (magnitude[2] !== 'Suffix') {
                prefixMagnitude += pct;
            }
            if (magnitude[2] !== 'Prefix') {
                suffixMagnitude += pct;
            }
        }
    }
    return {
        limits: { prefix: Math.max(0, prefix), suffix: Math.max(0, suffix) },
        magnitudes: { prefix: prefixMagnitude, suffix: suffixMagnitude },
    };
}

/** The most of each side over these bases (an empty list allows nothing). */
export function largestLimits(limits: readonly AffixLimits[]): AffixLimits {
    return {
        prefix: Math.max(0, ...limits.map((l: AffixLimits) => l.prefix)),
        suffix: Math.max(0, ...limits.map((l: AffixLimits) => l.suffix)),
    };
}
