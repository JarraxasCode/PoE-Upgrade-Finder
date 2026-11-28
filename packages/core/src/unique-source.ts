// A unique search's source for the spec (#113): the picked unique's own weights (engine `uniques`: the gain per
// point of each rolling line, PoB-scored), the unique's name and base for the query, and rarity unique. It takes
// the place of PoB's generator weights and the slot plan; the strip's hard needs and the floors still apply.

import type { UniqueInfo } from '@poe-upgrade-finder/engine-client';
import { categoryOf } from '@poe-upgrade-finder/vocab';
import { PSEUDO_TOTALS } from './pseudo-totals.ts';
import type { PseudoSource, PseudoTotal } from './pseudo-totals.ts';
import type { RunContext, SearchRequirement, SpecContribution, SpecSource, WeightedStat } from './spec.ts';
import type { PickedUnique } from '@poe-upgrade-finder/vocab';

export class UniqueSource implements SpecSource {
    public readonly id: string = 'unique';
    private readonly unique: UniqueInfo;
    private readonly itemType: string;

    /** From PoB's data for the picked unique, and the plan's item type (the search's category). */
    public constructor(unique: UniqueInfo, itemType: string) {
        this.unique = unique;
        this.itemType = itemType;
    }

    public contribute(_context: RunContext): SpecContribution {
        const weights: WeightedStat[] = this.unique.weights
            .map((w: UniqueInfo['weights'][number]) => ({ statId: w.id, weight: w.weight }))
            .sort((a: WeightedStat, b: WeightedStat) => Math.abs(b.weight) - Math.abs(a.weight));
        // An item type with no category of its own (none for a unique's base) keeps PoB's.
        const category: string | undefined = categoryOf(this.itemType);
        const foulborn = this.unique.foulborn;
        const unique: PickedUnique = {
            name: this.unique.name,
            base: this.unique.base,
            tradeType: this.unique.tradeType,
            ...(foulborn === null ? {} : { foulborn: foulborn.modId }),
        };
        // A Foulborn version's mutated line tells it from the unique's other Foulborn versions on the site (P31).
        const requirements: SearchRequirement[] =
            foulborn?.statId === undefined
                ? []
                : [{ statId: foulborn.statId, origin: 'plan', label: `Required: Foulborn ${foulborn.line}, from plan` }];
        return {
            weights: weights,
            rarity: 'unique',
            unique: unique,
            requirements: requirements,
            ...(category === undefined ? {} : { category: category }),
        };
    }
}

function hashOf(statId: string): string {
    return statId.slice(statId.lastIndexOf('.') + 1);
}

/**
 * The hard needs no line of the unique can carry: a pseudo total none of whose sources the unique has, or a stat
 * the unique doesn't have. Only a corruption or an enchant could then meet them, so the run says so up front.
 */
export function uniqueNeedGaps(unique: UniqueInfo, requirements: readonly SearchRequirement[]): SearchRequirement[] {
    const hashes: ReadonlySet<string> = new Set<string>(unique.statIds.map(hashOf));
    return requirements.filter((r: SearchRequirement) => {
        const total: PseudoTotal | undefined = PSEUDO_TOTALS.find((t: PseudoTotal) => t.id === r.statId);
        if (total !== undefined) {
            return !total.sources.some((s: PseudoSource) => hashes.has(s.hash));
        }
        return !hashes.has(hashOf(r.statId));
    });
}
