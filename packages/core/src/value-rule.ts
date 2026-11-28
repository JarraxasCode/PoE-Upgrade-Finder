// The value pick (PLAN.md, Scoring & ranking, step 4). Among floor-passing, de-duplicated items within the
// budget (the over-budget band is shown but never picked) with a chaos price: best = the highest gain. If best
// is under the minimum gain, the verdict is "no upgrade found". Otherwise the pick is the cheapest item with
// gain ≥ 80% of best and at least the minimum gain (ties go to the higher gain); the note names the best.
//
// "At least the minimum gain" is ours: without it, a best of +1.1% could make a +0.9% item the pick while
// the junk filter hides it as under the minimum.

import type { EvaluatedItem } from './evaluate.ts';
import type { FilteredItem } from './junk.ts';
import { DEFAULT_MIN_GAIN_PCT } from './junk.ts';

export const DEFAULT_VALUE_SHARE: number = 0.8;

/** What the run saw, so a "no upgrade" note can name its cause (issue #72). */
export interface RunOutcome {
    /** Listing ids the in-budget searches returned. */
    readonly listings: number;
    /** Set when the run stopped early (cancelled, signed out, a refused query, ...). */
    readonly stoppedReason: string | undefined;
    /**
     * What narrowed the search (#34), for the note when no listing in budget matched: "chaos res ≥ 22 (from a
     * floor in Settings)", "Links ≥ 6". Undefined: the caller has no list, and the note says only that none matched.
     */
    readonly causes?: readonly string[] | undefined;
    /** Listing ids the over-budget band's searches returned. */
    readonly overBudgetListings?: number | undefined;
}

/** The note when no listing in budget matched: what narrowed the search and what to try (#34). */
function noListingsNote(outcome: RunOutcome): string {
    const parts: string[] = ['No upgrade found: no listings in budget matched the search.'];
    if (outcome.causes === undefined) {
        return parts[0] ?? '';
    }
    const over: number = outcome.overBudgetListings ?? 0;
    if (over > 0) {
        parts.push(`${plural(over, 'listing', 'listings')} just over budget did.`);
    }
    // Whisper listings are the user's own choice (Jarraxas, 28 Nov): never suggested.
    if (outcome.causes.length > 0) {
        parts.push(`What narrowed it: ${outcome.causes.join('; ')}.`);
        parts.push('Try a bigger budget, or loosening one of these.');
    } else {
        parts.push('Try a bigger budget.');
    }
    return parts.join(' ');
}

export interface ValueSettings {
    readonly minGainPct?: number;
    /** The 80% rule. */
    readonly valueShare?: number;
}

export type Verdict =
    | {
          readonly kind: 'no-upgrade';
          readonly best: EvaluatedItem | undefined;
          readonly note: string;
          readonly overBudget: readonly EvaluatedItem[];
      }
    | {
          readonly kind: 'pick';
          readonly pick: EvaluatedItem;
          readonly best: EvaluatedItem;
          readonly note: string;
          readonly overBudget: readonly EvaluatedItem[];
      };

function pct(n: number): string {
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function describe(e: EvaluatedItem): string {
    const price: string = e.item.chaosEquivalent === undefined ? 'no chaos price' : `${Math.round(e.item.chaosEquivalent * 10) / 10}c`;
    return `${e.item.name || e.item.baseType} (${pct(e.gain.gain)} overall: DPS ${pct(e.gain.dpsPct)}, EHP ${pct(e.gain.ehpPct)}; ${price})`;
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** Why nothing in budget could be the pick, from the in-budget items and what the run saw. */
function nothingNote(inBudget: readonly FilteredItem[], outcome: RunOutcome | undefined): string {
    // The stop reason itself is shown beside the verdict; it is named here only when it is the cause.
    const stopped: string | undefined = outcome?.stoppedReason?.replace(/\.$/, '');
    if (inBudget.length === 0) {
        if (stopped !== undefined) {
            return `No upgrade found: the run stopped before anything in budget was scored (${stopped}).`;
        }
        if (outcome === undefined) {
            return 'No upgrade found: nothing in budget was scored.';
        }
        if (outcome.listings === 0) {
            return noListingsNote(outcome);
        }
        return `No upgrade found: none of the ${plural(outcome.listings, 'listing', 'listings')} in budget could be scored (the run summary says why).`;
    }
    const count = (test: (f: FilteredItem) => boolean): number => inBudget.filter(test).length;
    const floors: number = count((f: FilteredItem) => f.hidden === 'floor');
    const noGain: number = count((f: FilteredItem) => f.hidden === 'no-gain');
    const duplicates: number = count((f: FilteredItem) => f.hidden === 'duplicate');
    const unpriced: number = count(
        (f: FilteredItem) =>
            f.hidden !== 'floor' && f.hidden !== 'no-gain' && f.hidden !== 'duplicate' && f.evaluated.item.chaosEquivalent === undefined,
    );
    const n: number = inBudget.length;
    if (floors === n) {
        return `No upgrade found: ${n === 1 ? 'the one item' : `all ${n} items`} scored in budget failed a floor.`;
    }
    const parts: string[] = [];
    if (floors > 0) {
        parts.push(`${floors} failed a floor`);
    }
    if (noGain > 0) {
        parts.push(`${noGain} had no gain figure`);
    }
    if (duplicates > 0) {
        parts.push(`${plural(duplicates, 'was a repeat listing', 'were repeat listings')}`);
    }
    if (unpriced > 0) {
        parts.push(`${unpriced} had no chaos price`);
    }
    return `No upgrade found: of the ${plural(n, 'item', 'items')} scored in budget, ${parts.join(', ')}.`;
}

/** The value pick; `outcome` (the run's counts and stop reason) lets a "no upgrade" verdict say why. */
export function valuePick(items: readonly FilteredItem[], settings: ValueSettings = {}, outcome?: RunOutcome): Verdict {
    const minGain: number = settings.minGainPct ?? DEFAULT_MIN_GAIN_PCT;
    const share: number = settings.valueShare ?? DEFAULT_VALUE_SHARE;
    const eligible = (f: FilteredItem): boolean =>
        f.hidden !== 'floor' &&
        f.hidden !== 'duplicate' &&
        f.hidden !== 'no-gain' &&
        f.evaluated.item.chaosEquivalent !== undefined &&
        !Number.isNaN(f.evaluated.gain.gain);
    const inBudget: EvaluatedItem[] = items
        .filter((f: FilteredItem) => eligible(f) && f.evaluated.item.role === 'main')
        .map((f: FilteredItem) => f.evaluated);
    const overCandidates: EvaluatedItem[] = items
        .filter((f: FilteredItem) => eligible(f) && f.evaluated.item.role === 'over')
        .map((f: FilteredItem) => f.evaluated);

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
        const note: string =
            best === undefined
                ? nothingNote(
                      items.filter((f: FilteredItem) => f.evaluated.item.role === 'main'),
                      outcome,
                  )
                : `No upgrade found: the best in budget is ${describe(best)}, under the +${minGain}% minimum.`;
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
