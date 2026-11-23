// What changes when a find replaces the current item (Phase 4: "-20 life, +20% res, ..."):
// PoB's own numbers for the build with each item, against the baseline, for the stats a player compares.
// Like PoB's compare tooltip, these are the build's totals, so they already account for everything else
// on the character. Pure, so it is unit-tested.

import { stat } from '@poe-upgrade-finder/core';
import type { PobStats } from '@poe-upgrade-finder/core';
import type { StatChange } from '@poe-upgrade-finder/ipc';

interface Shown {
    readonly label: string;
    readonly read: (s: PobStats) => number | undefined;
    readonly unit: '' | '%';
    /** Smaller changes are noise (rounding, a fraction of a point). */
    readonly min: number;
}

const plain = (key: string, label: string, unit: '' | '%' = '', min: number = 1): Shown => ({
    label: label,
    read: (s: PobStats) => stat(s, key),
    unit: unit,
    min: min,
});

function maxResOf(element: string): (s: PobStats) => number | undefined {
    return (s: PobStats): number | undefined => {
        const final: number | undefined = stat(s, `${element}Resist`);
        const missing: number | undefined = stat(s, `Missing${element}Resist`);
        return final === undefined ? undefined : final + (missing ?? 0);
    };
}

/** In the order a player reads them: pools, resistances, attributes, defences, then the rest. */
const SHOWN: readonly Shown[] = [
    plain('Life', 'Life'),
    plain('EnergyShield', 'Energy shield'),
    plain('Mana', 'Mana'),
    plain('Ward', 'Ward'),
    plain('FireResistTotal', 'Fire res', '%'),
    plain('ColdResistTotal', 'Cold res', '%'),
    plain('LightningResistTotal', 'Lightning res', '%'),
    plain('ChaosResistTotal', 'Chaos res', '%'),
    { label: 'Max fire res', read: maxResOf('Fire'), unit: '%', min: 1 },
    { label: 'Max cold res', read: maxResOf('Cold'), unit: '%', min: 1 },
    { label: 'Max lightning res', read: maxResOf('Lightning'), unit: '%', min: 1 },
    plain('Str', 'Strength'),
    plain('Dex', 'Dexterity'),
    plain('Int', 'Intelligence'),
    plain('Armour', 'Armour', '', 10),
    plain('Evasion', 'Evasion', '', 10),
    plain('BlockChance', 'Block', '%'),
    plain('SpellBlockChance', 'Spell block', '%'),
    plain('SpellSuppressionChance', 'Spell suppression', '%'),
    {
        label: 'Movement speed',
        read: (s: PobStats) => {
            const v: number | undefined = stat(s, 'EffectiveMovementSpeedMod');
            return v === undefined ? undefined : v * 100;
        },
        unit: '%',
        min: 1,
    },
    plain('LifeRegenRecovery', 'Life regen /s', '', 1),
];

/** The stats that move by at least their noise floor, rounded as PoB shows them. */
export function statChanges(baseline: PobStats, withItem: PobStats): StatChange[] {
    const out: StatChange[] = [];
    for (const s of SHOWN) {
        const before: number | undefined = s.read(baseline);
        const after: number | undefined = s.read(withItem);
        if (before === undefined && after === undefined) {
            continue;
        }
        const delta: number = Math.round((after ?? 0) - (before ?? 0));
        if (Math.abs(delta) >= s.min) {
            out.push({ label: s.label, delta: delta, unit: s.unit });
        }
    }
    return out;
}
