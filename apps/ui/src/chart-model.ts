// The price-vs-gain chart and "best per band" on the results (PLAN.md, UI: Run: done). Pure (no DOM), so it is
// unit-tested; the view (views/price-gain-chart.tsx) only maps these to pixels.

import type { RunHeader, UiBand, UiItem } from '@poe-upgrade-finder/ipc';
import { byGain } from './run-model.ts';

/** Worth a look (shown), broke a floor, or filtered for another reason (side-grade, dominated, ...). */
export type PointKind = 'worth' | 'floor' | 'other';

export interface ChartPoint {
    readonly item: UiItem;
    readonly kind: PointKind;
    /** Price in chaos (> 0). */
    readonly x: number;
    /** Overall gain in percent, as PoB scored it. */
    readonly y: number;
    /** True when y is below the axis floor: drawn on the bottom edge, its value in the readout. */
    readonly clipped: boolean;
}

export interface Axis {
    readonly min: number;
    readonly max: number;
    readonly ticks: readonly number[];
}

export interface ChartModel {
    readonly points: readonly ChartPoint[];
    /** Price axis, log scale (prices run from 1c to hundreds). */
    readonly x: Axis;
    /** Gain axis, linear. */
    readonly y: Axis;
    readonly budgetChaos: number;
    readonly minGainPct: number;
    /** Items with no chaos price or no gain figure: not on the chart, still in the list. */
    readonly unplotted: number;
    /** Points drawn on the bottom edge because their gain is below the axis floor. */
    readonly clipped: number;
}

/** The gain axis reaches at least this low; below it, only the worst ~10% of points are clipped, so a few −40% items
 *  don't flatten the rest while a run of mostly bad items still shows them. */
export const GAIN_AXIS_FLOOR: number = -10;
export const CLIP_SHARE: number = 0.1;

/** The bottom of the gain axis (before rounding to a tick): 0 or the lowest point when that is above the floor,
 *  else the lower of the floor and the gain at the CLIP_SHARE quantile. */
export function gainAxisLow(gains: readonly number[]): number {
    const sorted: number[] = [...gains].sort((a: number, b: number) => a - b);
    const lowest: number = sorted[0] ?? 0;
    if (lowest >= GAIN_AXIS_FLOOR) {
        return Math.min(0, lowest);
    }
    const quantile: number = sorted[Math.floor(sorted.length * CLIP_SHARE)] ?? lowest;
    return Math.min(GAIN_AXIS_FLOOR, quantile);
}

export function pointKind(item: UiItem): PointKind {
    if (item.hidden === null) {
        return 'worth';
    }
    return item.hidden === 'floor' ? 'floor' : 'other';
}

export function chartModel(items: readonly UiItem[], header: Pick<RunHeader, 'budgetChaos' | 'minGainPct'>): ChartModel | null {
    const plotted: UiItem[] = items.filter((i: UiItem) => i.chaos !== null && i.chaos > 0 && i.gainPct !== null && Number.isFinite(i.gainPct));
    if (plotted.length === 0) {
        return null;
    }
    const xs: number[] = plotted.map((i: UiItem) => i.chaos ?? 1);
    const ys: number[] = plotted.map((i: UiItem) => i.gainPct ?? 0);
    const x: Axis = logAxis(Math.min(...xs), Math.max(Math.max(...xs), header.budgetChaos));
    const yLow: number = gainAxisLow(ys);
    const y: Axis = linearAxis(yLow, Math.max(...ys, header.minGainPct, 1));
    let clipped: number = 0;
    const points: ChartPoint[] = plotted.map((item: UiItem): ChartPoint => {
        const g: number = item.gainPct ?? 0;
        const isClipped: boolean = g < y.min;
        if (isClipped) {
            clipped++;
        }
        return { item: item, kind: pointKind(item), x: item.chaos ?? 1, y: isClipped ? y.min : g, clipped: isClipped };
    });
    // Worth-a-look points last, so they draw on top of the gray ones.
    const order: Readonly<Record<PointKind, number>> = { other: 0, floor: 1, worth: 2 };
    points.sort((a: ChartPoint, b: ChartPoint) => order[a.kind] - order[b.kind]);
    return { points: points, x: x, y: y, budgetChaos: header.budgetChaos, minGainPct: header.minGainPct, unplotted: items.length - plotted.length, clipped: clipped };
}

/** Log axis padded a little past the data, with 1-2-5 ticks (1-3 or powers of ten when that would crowd). */
export function logAxis(lo: number, hi: number): Axis {
    const min: number = Math.max(0.1, lo / 1.4);
    const max: number = Math.max(min * 10, hi * 1.25);
    for (const mantissas of [[1, 2, 5], [1, 3], [1]]) {
        const ticks: number[] = [];
        for (let e: number = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
            for (const m of mantissas) {
                const t: number = m * 10 ** e;
                if (t >= min && t <= max) {
                    ticks.push(Number(t.toPrecision(6)));
                }
            }
        }
        if (ticks.length <= 7) {
            return { min: min, max: max, ticks: ticks };
        }
    }
    return { min: min, max: max, ticks: [] };
}

/** Linear axis on clean steps (1, 2, 2.5, 5 × 10^k), about five ticks, always including 0 when in range. */
export function linearAxis(lo: number, hi: number): Axis {
    const span: number = Math.max(hi - lo, 1e-9);
    const raw: number = span / 5;
    const power: number = 10 ** Math.floor(Math.log10(raw));
    const step: number = ([1, 2, 2.5, 5, 10].map((m: number) => m * power).find((s: number) => s >= raw)) ?? 10 * power;
    const min: number = Math.floor(lo / step) * step;
    const max: number = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let t: number = min; t <= max + step / 2; t += step) {
        ticks.push(Number(t.toFixed(6)));
    }
    return { min: min, max: max, ticks: ticks };
}

/** 0..1 along a log axis. */
export function logPos(axis: Axis, v: number): number {
    return (Math.log10(v) - Math.log10(axis.min)) / (Math.log10(axis.max) - Math.log10(axis.min));
}

/** 0..1 along a linear axis. */
export function linPos(axis: Axis, v: number): number {
    return (v - axis.min) / (axis.max - axis.min);
}

/** "1c", "250c", "1.5k c" for price ticks. */
export function priceTick(v: number): string {
    if (v >= 1000) {
        return `${Number((v / 1000).toPrecision(3))}k c`;
    }
    return `${Number(v.toPrecision(3))}c`;
}

export interface BandBest {
    readonly band: UiBand;
    /** The highest overall gain in the band among items that pass the floors; null when none was scored. */
    readonly best: UiItem | null;
    /** Items in the band still worth a look after the junk filter. */
    readonly worth: number;
    readonly scored: number;
}

/** Best per band: what the top of each price point looks like, whether or not it cleared the minimum gain. */
export function bestPerBand(items: readonly UiItem[], bands: readonly UiBand[]): BandBest[] {
    return bands.map((band: UiBand): BandBest => {
        const inBand: UiItem[] = items.filter((i: UiItem) => i.bandId === band.id);
        const candidates: UiItem[] = inBand.filter((i: UiItem) => i.floorsPass && i.gainPct !== null).sort(byGain);
        return { band: band, best: candidates[0] ?? null, worth: inBand.filter((i: UiItem) => i.hidden === null).length, scored: inBand.length };
    });
}
