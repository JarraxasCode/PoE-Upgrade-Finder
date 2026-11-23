// What the Run view shows, worked out from the run's state. Pure (no DOM), so it is unit-tested.

import type {
    HiddenReason,
    PlanCheckStatus,
    RunHeader,
    RunPhase,
    RunSnapshot,
    UiBand,
    UiItem,
    UiPlanCheck,
    UiSearch,
} from '@poe-upgrade-finder/ipc';

/** While live the junk filter hasn't run yet: a "good find" passes the floors and clears the minimum gain. */
export function isGoodFind(item: UiItem, minGainPct: number): boolean {
    return item.floorsPass && item.gainPct !== null && item.gainPct >= minGainPct;
}

/** Best gain first; equal gains, cheaper first. */
export function byGain(a: UiItem, b: UiItem): number {
    const g: number = (b.gainPct ?? Number.NEGATIVE_INFINITY) - (a.gainPct ?? Number.NEGATIVE_INFINITY);
    return g !== 0 ? g : (a.chaos ?? Number.POSITIVE_INFINITY) - (b.chaos ?? Number.POSITIVE_INFINITY);
}

export function goodFinds(items: readonly UiItem[], minGainPct: number): UiItem[] {
    return items.filter((i: UiItem) => isGoodFind(i, minGainPct)).sort(byGain);
}

export interface LiveFiltered {
    readonly floor: number;
    readonly sideGrade: number;
    readonly total: number;
}

export function liveFiltered(items: readonly UiItem[], minGainPct: number): LiveFiltered {
    let floor: number = 0;
    let sideGrade: number = 0;
    for (const i of items) {
        if (!i.floorsPass) {
            floor++;
        } else if (!isGoodFind(i, minGainPct)) {
            sideGrade++;
        }
    }
    return { floor: floor, sideGrade: sideGrade, total: floor + sideGrade };
}

export type BandStatus = 'waiting' | 'searching' | 'done' | 'refused';

/** The trade site stops counting at 10,000 matches per search. */
export const SITE_TOTAL_CAP: number = 10000;

/** "DPS 50% + EHP 50%". */
export function blendText(blend: number): string {
    const dps: number = Math.round(blend * 100);
    return `DPS ${dps}% + EHP ${100 - dps}%`;
}

export interface BandRow {
    readonly band: UiBand;
    readonly status: BandStatus;
    /** Listings the site matched, both currencies. */
    readonly matches: number | null;
    /** The site counts at most 10,000 per search: true when a search hit that cap. */
    readonly matchesCapped: boolean;
    readonly planned: number;
    readonly scored: number;
    /** The best overall gain among this band's items that pass the floors, or null. */
    readonly best: number | null;
}

function bestGain(items: readonly UiItem[]): number | null {
    let best: number | null = null;
    for (const i of items) {
        if (i.gainPct !== null && (best === null || i.gainPct > best)) {
            best = i.gainPct;
        }
    }
    return best;
}

export function bandRows(snap: RunSnapshot): BandRow[] {
    const live: boolean = snap.phase === 'searching' || snap.phase === 'paused';
    let current: boolean = false;
    return snap.header.bands.map((band: UiBand): BandRow => {
        const searches: UiSearch[] = snap.searches.filter((s: UiSearch) => s.bandId === band.id);
        const done: boolean = snap.bandsDone.includes(band.id);
        const refused: boolean = searches.length > 0 && searches.every((s: UiSearch) => s.error !== null);
        let status: BandStatus = 'waiting';
        if (refused) {
            status = 'refused';
        } else if (done) {
            status = 'done';
        } else if (live && !current) {
            current = true;
            status = 'searching';
        }
        const totals: number[] = searches.map((s: UiSearch) => s.total ?? 0);
        return {
            band: band,
            status: status,
            matches: searches.length === 0 ? null : totals.reduce((a: number, b: number) => a + b, 0),
            matchesCapped: totals.some((t: number) => t >= SITE_TOTAL_CAP),
            planned: searches.reduce((a: number, s: UiSearch) => a + s.fetchPlanned, 0),
            scored: snap.items.filter((i: UiItem) => i.bandId === band.id).length,
            best: bestGain(snap.items.filter((i: UiItem) => i.bandId === band.id && i.floorsPass)),
        };
    });
}

export interface Progress {
    readonly scored: number;
    /** An estimate: planned for bands searched so far, the depth for the rest. */
    readonly expected: number;
    readonly bandIndex: number;
    readonly bands: number;
}

export function progress(snap: RunSnapshot): Progress {
    const rows: BandRow[] = bandRows(snap);
    let expected: number = 0;
    for (const r of rows) {
        expected += r.matches === null ? snap.header.perBand : r.planned;
    }
    const searching: number = rows.findIndex((r: BandRow) => r.status === 'searching');
    const doneCount: number = rows.filter((r: BandRow) => r.status === 'done' || r.status === 'refused').length;
    return {
        scored: snap.items.length,
        expected: Math.max(expected, snap.items.length),
        bandIndex: searching >= 0 ? searching + 1 : doneCount,
        bands: rows.length,
    };
}

export function isLive(phase: RunPhase): boolean {
    return phase === 'preparing' || phase === 'searching' || phase === 'paused';
}

export function bandLabel(header: RunHeader, bandId: string): string {
    const b: UiBand | undefined = header.bands.find((x: UiBand) => x.id === bandId);
    return b === undefined ? bandId : b.label;
}

export function priceText(item: UiItem): string {
    if (item.price === null) {
        return 'no price';
    }
    const unit: string = item.price.currency === 'chaos' ? 'c' : item.price.currency === 'divine' ? ' div' : ` ${item.price.currency}`;
    return `${Number.isInteger(item.price.amount) ? item.price.amount : item.price.amount.toFixed(2)}${unit}`;
}

export const HIDDEN_LABELS: Readonly<Record<HiddenReason, string>> = {
    floor: 'break a floor',
    'no-gain': 'no gain figure',
    'low-gain': 'side-grades under the minimum gain',
    duplicate: 'listed again by the same seller',
    dominated: 'beaten by something cheaper',
};

export function hiddenCounts(items: readonly UiItem[]): Map<HiddenReason, number> {
    const out: Map<HiddenReason, number> = new Map<HiddenReason, number>();
    for (const i of items) {
        if (i.hidden !== null) {
            out.set(i.hidden, (out.get(i.hidden) ?? 0) + 1);
        }
    }
    return out;
}

/** The plan chip on a find's row: every check met, some missed, or not checkable; null without a plan. */
export interface PlanChip {
    readonly text: string;
    readonly status: PlanCheckStatus;
}

export function planChip(checks: readonly UiPlanCheck[]): PlanChip | null {
    if (checks.length === 0) {
        return null;
    }
    const missed: number = checks.filter((c: UiPlanCheck) => c.status === 'missed').length;
    if (missed > 0) {
        return { text: `Plan: ${missed} missed`, status: 'missed' };
    }
    if (checks.some((c: UiPlanCheck) => c.status === 'unknown')) {
        return { text: 'Plan: not checked', status: 'unknown' };
    }
    return { text: 'Plan ✓', status: 'met' };
}

export const PLAN_MARK: Readonly<Record<PlanCheckStatus, string>> = { met: '✓', missed: '✗', unknown: '?' };

/** One check as a line of text: "✓ +# total to Dexterity (≥ 30): total 34". */
export function planCheckText(c: UiPlanCheck): string {
    const what: string = c.kind === 'exclude' ? `none of: ${c.label}` : c.label;
    return `${PLAN_MARK[c.status]} ${what}${c.value === null ? '' : `: ${c.value}`}`;
}

/** A check's value on its chip: a defence as the site compares it (the at-20% figure), anything else as is. */
export function chipValue(c: UiPlanCheck): string | null {
    if (c.value === null) {
        return null;
    }
    if (c.kind === 'defence') {
        const at20: RegExpMatchArray | null = /([\d,.]+) at 20%/.exec(c.value);
        if (at20?.[1] !== undefined) {
            return at20[1];
        }
    }
    return c.value.replace(/^total /, '');
}

/** The run's slot was empty in PoB (issue #33): main names the current item "nothing" and has no view of it. */
export function slotWasEmpty(h: RunHeader): boolean {
    return h.currentView === null && h.currentItem === 'nothing';
}

/** "your Gale Talons, Leviathan Gauntlets", or "an empty slot". */
export function currentItemText(h: RunHeader): string {
    return slotWasEmpty(h) ? 'an empty slot' : `your ${h.currentItem}`;
}
