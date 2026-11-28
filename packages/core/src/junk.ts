// The junk filter (PLAN.md, Scoring & ranking, step 5): hidden by default, one click away. In order, an item
// is hidden for the first rule it meets:
//   floor       a floor failed
//   no-gain     the gain has no number (a change from 0 or from infinity; see percentChange)
//   low-gain    gain under the minimum
//   duplicate   the same item listed again by the same seller (the cheapest listing stays)
//   dominated   another shown item costs less and gains more (both strictly)
// Items priced in another currency have no chaos equivalent, so they never dominate or get dominated.

import type { JunkReason } from '@poe-upgrade-finder/vocab';
import type { EvaluatedItem } from './evaluate.ts';

export const DEFAULT_MIN_GAIN_PCT: number = 1;

export interface FilteredItem {
    readonly evaluated: EvaluatedItem;
    /** Undefined: shown. */
    readonly hidden: JunkReason | undefined;
    /** For 'duplicate' and 'dominated': the listing id that wins over it. */
    readonly hiddenBy: string | undefined;
}

/** A row while the filter works on it (FilteredItem, mutable). */
interface Row {
    readonly evaluated: EvaluatedItem;
    hidden: JunkReason | undefined;
    hiddenBy: string | undefined;
}

function priceOf(row: Row): number {
    return row.evaluated.item.chaosEquivalent ?? Number.POSITIVE_INFINITY;
}

export function junkFilter(items: readonly EvaluatedItem[], minGainPct: number = DEFAULT_MIN_GAIN_PCT): FilteredItem[] {
    const out: Row[] = items.map((e: EvaluatedItem): Row => {
        if (!e.floorsPass) {
            return { evaluated: e, hidden: 'floor', hiddenBy: undefined };
        }
        if (Number.isNaN(e.gain.gain)) {
            return { evaluated: e, hidden: 'no-gain', hiddenBy: undefined };
        }
        if (e.gain.gain < minGainPct) {
            return { evaluated: e, hidden: 'low-gain', hiddenBy: undefined };
        }
        return { evaluated: e, hidden: undefined, hiddenBy: undefined };
    });

    // Duplicates: same seller and item text. Keep the cheapest (then the first seen).
    const bestOf: Map<string, number> = new Map<string, number>();
    out.forEach((row: Row, i: number) => {
        const seller: string | undefined = row.evaluated.item.seller;
        if (row.hidden !== undefined || seller === undefined) {
            return;
        }
        const key: string = `${seller}\n${row.evaluated.item.text}`;
        const j: number | undefined = bestOf.get(key);
        const kept: Row | undefined = j === undefined ? undefined : out[j];
        if (j === undefined || kept === undefined) {
            bestOf.set(key, i);
            return;
        }
        if (priceOf(row) < priceOf(kept)) {
            kept.hidden = 'duplicate';
            kept.hiddenBy = row.evaluated.item.id;
            bestOf.set(key, i);
        } else {
            row.hidden = 'duplicate';
            row.hiddenBy = kept.evaluated.item.id;
        }
    });

    // Dominated: the shown set becomes the price/gain frontier (dominance is transitive, so one pass over the
    // shown items, sorted by price, finds it).
    const shown: Row[] = out
        .filter((r: Row) => r.hidden === undefined && r.evaluated.item.chaosEquivalent !== undefined)
        .sort((a: Row, b: Row) => priceOf(a) - priceOf(b));
    for (const row of shown) {
        let winner: EvaluatedItem | undefined;
        for (const other of shown) {
            if (priceOf(other) >= priceOf(row)) {
                break;
            }
            if (
                other.evaluated.gain.gain > row.evaluated.gain.gain &&
                (winner === undefined || other.evaluated.gain.gain > winner.gain.gain)
            ) {
                winner = other.evaluated;
            }
        }
        if (winner !== undefined) {
            row.hidden = 'dominated';
            row.hiddenBy = winner.item.id;
        }
    }
    return out;
}
