// The value pick (PLAN.md, Scoring & ranking, step 4). Among floor-passing, de-duplicated items within the
// budget (the over-budget band is shown but never picked) with a chaos price: best = the highest gain. If best
// is under the minimum gain, the verdict is "no upgrade found". Otherwise the pick is the cheapest item with
// gain ≥ 80% of best and at least the minimum gain (ties go to the higher gain); the note names the best.
//
// "At least the minimum gain" is ours: without it, a best of +1.1% could make a +0.9% item the pick while
// the junk filter hides it as under the minimum.

import type { BandRole, PriceBand } from './bands.ts';
import type { EvaluatedItem } from './evaluate.ts';
import type { FilteredItem } from './junk.ts';
import { DEFAULT_MIN_GAIN_PCT } from './junk.ts';

export const DEFAULT_VALUE_SHARE: number = 0.8;

export interface ValueSettings {
    readonly minGainPct?: number;
    /** The 80% rule. */
    readonly valueShare?: number;
}

export type Verdict =
    | { readonly kind: 'no-upgrade'; readonly best: EvaluatedItem | undefined; readonly note: string; readonly overBudget: readonly EvaluatedItem[] }
    | { readonly kind: 'pick'; readonly pick: EvaluatedItem; readonly best: EvaluatedItem; readonly note: string; readonly overBudget: readonly EvaluatedItem[] };

function pct(n: number): string {
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function describe(e: EvaluatedItem): string {
    const price: string = e.item.chaosEquivalent === undefined ? 'no chaos price' : `${Math.round(e.item.chaosEquivalent * 10) / 10}c`;
    return `${e.item.name || e.item.baseType} (${pct(e.gain.gain)} overall: DPS ${pct(e.gain.dpsPct)}, EHP ${pct(e.gain.ehpPct)}; ${price})`;
}

export function valuePick(items: readonly FilteredItem[], bands: readonly PriceBand[], settings: ValueSettings = {}): Verdict {
    const minGain: number = settings.minGainPct ?? DEFAULT_MIN_GAIN_PCT;
    const share: number = settings.valueShare ?? DEFAULT_VALUE_SHARE;
    const roleOf: Map<string, BandRole> = new Map<string, BandRole>(bands.map((b: PriceBand) => [b.id, b.role]));
    const eligible = (f: FilteredItem): boolean =>
        f.hidden !== 'floor' && f.hidden !== 'duplicate' && f.hidden !== 'no-gain' && f.evaluated.item.chaosEquivalent !== undefined && !Number.isNaN(f.evaluated.gain.gain);
    const inBudget: EvaluatedItem[] = items.filter((f: FilteredItem) => eligible(f) && roleOf.get(f.evaluated.item.bandId) === 'main').map((f: FilteredItem) => f.evaluated);
    const overCandidates: EvaluatedItem[] = items.filter((f: FilteredItem) => eligible(f) && roleOf.get(f.evaluated.item.bandId) === 'over').map((f: FilteredItem) => f.evaluated);

    let best: EvaluatedItem | undefined;
    for (const e of inBudget) {
        if (best === undefined || e.gain.gain > best.gain.gain) {
            best = e;
        }
    }
    const bestGain: number = best?.gain.gain ?? Number.NEGATIVE_INFINITY;
    // Over-budget items that beat everything in budget, best first: notes only.
    const overBudget: EvaluatedItem[] = overCandidates
        .filter((e: EvaluatedItem) => e.gain.gain > Math.max(bestGain, minGain))
        .sort((a: EvaluatedItem, b: EvaluatedItem) => b.gain.gain - a.gain.gain);
    if (best === undefined || best.gain.gain < minGain) {
        const note: string = best === undefined ? 'No upgrade found: nothing in budget passed the floors.' : `No upgrade found: the best in budget is ${describe(best)}, under the +${minGain}% minimum.`;
        return { kind: 'no-upgrade', best: best, note: note, overBudget: overBudget };
    }
    const threshold: number = Math.max(share * best.gain.gain, minGain);
    let pick: EvaluatedItem = best;
    for (const e of inBudget) {
        if (e.gain.gain < threshold) {
            continue;
        }
        const price: number = e.item.chaosEquivalent ?? Number.POSITIVE_INFINITY;
        const pickPrice: number = pick.item.chaosEquivalent ?? Number.POSITIVE_INFINITY;
        if (price < pickPrice || (price === pickPrice && e.gain.gain > pick.gain.gain)) {
            pick = e;
        }
    }
    const note: string =
        pick === best
            ? `Pick: ${describe(pick)}, the best in budget.`
            : `Pick: ${describe(pick)}, at least ${Math.round(share * 100)}% of the best. The best is ${describe(best)}.`;
    return { kind: 'pick', pick: pick, best: best, note: note, overBudget: overBudget };
}
