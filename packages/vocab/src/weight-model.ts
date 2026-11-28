// The weight review's rules (PLAN.md, "Review PoB's weights before searching"; issue #111), in one place for the
// spec builder (core), the review rows, its counts and the search button (renderer).
//
// An edit is relative to PoB's weight for the stat, never an absolute weight: PoB generates the weights again
// for each target, blend and save, and an absolute edit made under one set could be ten times too strong under
// the next. `factor` scales PoB's weight (missing: 1); `off` leaves the stat out of the ranking and keeps the
// factor, so turning it back on restores it. Factors are positive, and the sign stays PoB's: PoB gives an
// inverted stat (one whose good rolls read as negative values) a negative weight, and an edit keeps that.

/** One stat's edit. An edit with neither field is no edit and is never stored. */
export interface WeightEdit {
    readonly factor?: number;
    readonly off?: true;
}

/** Stat id → edit, for one build and slot. */
export type WeightEdits = Readonly<Record<string, WeightEdit>>;

/** A weight as PoB generated it (structurally core's WeightedStat). */
export interface StatWeight {
    readonly statId: string;
    readonly weight: number;
}

/** The highest % of the top stat the review accepts. */
export const MAX_WEIGHT_PCT: number = 1000;

/** The largest factor an edit may store (a tiny PoB weight raised to MAX_WEIGHT_PCT of the top). */
export const MAX_WEIGHT_FACTOR: number = 1e6;

export function isOn(edit: WeightEdit | undefined): boolean {
    return edit?.off !== true;
}

/** The weight searched with: PoB's times the factor; undefined when the stat is off. */
export function effectiveWeight(pobWeight: number, edit: WeightEdit | undefined): number | undefined {
    if (!isOn(edit)) {
        return undefined;
    }
    return pobWeight * (edit?.factor ?? 1);
}

/** PoB's weights with the edits applied, in their order: off stats left out, factors applied, others as they are. */
export function applyWeightEdits<T extends StatWeight>(weights: readonly T[], edits: WeightEdits | undefined): T[] {
    const out: T[] = [];
    for (const w of weights) {
        const weight: number | undefined = effectiveWeight(w.weight, edits?.[w.statId]);
        if (weight !== undefined) {
            out.push(weight === w.weight ? w : { ...w, weight: weight });
        }
    }
    return out;
}

/** The review's 100%: the largest of PoB's weights by size (inverted stats count by size too). */
export function topWeight(weights: readonly StatWeight[]): number {
    const top: number = weights.reduce((m: number, w: StatWeight) => Math.max(m, Math.abs(w.weight)), 0);
    return top > 0 ? top : 1;
}

/** A weight as the review shows it: a whole % of the top, by size. */
export function percentOfTop(weight: number, top: number): number {
    return Math.round((Math.abs(weight) / top) * 100);
}

/** The % shown for a stat: its effective weight when on, PoB's when off (the box is disabled then). */
export function shownPercent(pobWeight: number, edit: WeightEdit | undefined, top: number): number {
    return percentOfTop(pobWeight * (edit?.factor ?? 1), top);
}

/** An edit, or undefined when it holds nothing (so it isn't stored). */
function normalise(factor: number | undefined, off: boolean): WeightEdit | undefined {
    if (factor === undefined && !off) {
        return undefined;
    }
    return { ...(factor === undefined ? {} : { factor: factor }), ...(off ? { off: true as const } : {}) };
}

/**
 * The edit after the user typed a %: undefined for no edit. Compared at the shown precision, so typing back PoB's
 * own % clears the factor instead of storing a near-1 one, and typing the % already shown changes nothing. Returns 'refused' for a % the review doesn't take
 * (not a number, 0 or below: the box turns a stat off only through its tick box).
 */
export function withPercent(edit: WeightEdit | undefined, pct: number, pobWeight: number, top: number): WeightEdit | undefined | 'refused' {
    if (!Number.isFinite(pct) || pct <= 0 || pobWeight === 0) {
        return 'refused';
    }
    const capped: number = Math.min(pct, MAX_WEIGHT_PCT);
    const off: boolean = !isOn(edit);
    // The % already shown: keep the edit as it is (a stored factor isn't rounded to the whole %).
    if (Math.round(capped) === shownPercent(pobWeight, edit, top)) {
        return edit;
    }
    if (Math.round(capped) === percentOfTop(pobWeight, top)) {
        return normalise(undefined, off);
    }
    const factor: number = Math.min(((capped / 100) * top) / Math.abs(pobWeight), MAX_WEIGHT_FACTOR);
    return normalise(factor, off);
}

/** The edit with the stat turned on or off; the factor is kept either way. */
export function withOn(edit: WeightEdit | undefined, on: boolean): WeightEdit | undefined {
    return normalise(edit?.factor, !on);
}

/** The review's summary line: stats searchable (not taken out by the plan), off, and reweighted (on, with a factor). */
export interface WeightCounts {
    readonly searchable: number;
    readonly on: number;
    readonly off: number;
    readonly reweighted: number;
}

export function weightCounts(weights: readonly StatWeight[], edits: WeightEdits, pruned: ReadonlySet<string>): WeightCounts {
    let searchable: number = 0;
    let off: number = 0;
    let reweighted: number = 0;
    for (const w of weights) {
        if (pruned.has(w.statId)) {
            continue;
        }
        searchable++;
        const edit: WeightEdit | undefined = edits[w.statId];
        if (!isOn(edit)) {
            off++;
        } else if (edit?.factor !== undefined) {
            reweighted++;
        }
    }
    return { searchable: searchable, on: searchable - off, off: off, reweighted: reweighted };
}
