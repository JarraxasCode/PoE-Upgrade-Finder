// Gain (PLAN.md, Scoring & ranking, step 3): gain = w × ΔDPS% + (1 − w) × ΔEHP%, where w is the user's
// DPS/EHP blend (default 0.5). The same w goes to PoB's generator as its DPS and EHP weights.

/** The part of an engine stat block the gain needs (structurally the engine client's StatBlock). */
export interface GainStats {
    readonly damage: number;
    readonly values: Readonly<Record<string, number | boolean>>;
}

export interface Gain {
    /** Change in the damage target, in percent. */
    readonly dpsPct: number;
    /** Change in TotalEHP, in percent. */
    readonly ehpPct: number;
    /** The blended gain, in percent. NaN when either change is undefined (see percentChange). */
    readonly gain: number;
}

export const DEFAULT_BLEND: number = 0.5;

/**
 * after / before − 1, in percent. Equal values (both infinite included) give 0. A change from 0 or from
 * infinity to something else has no percentage and gives NaN; the caller shows that rather than ranking on it.
 */
export function percentChange(before: number, after: number): number {
    if (before === after) {
        return 0;
    }
    if (before === 0 || !Number.isFinite(before) || Number.isNaN(after)) {
        return Number.NaN;
    }
    return (after / before - 1) * 100;
}

function ehpOf(stats: GainStats): number {
    const v: number | boolean | undefined = stats.values['TotalEHP'];
    return typeof v === 'number' ? v : Number.NaN;
}

export function checkBlend(blend: number): number {
    if (!(blend >= 0 && blend <= 1)) {
        throw new RangeError(`blend must be between 0 and 1, got ${blend}`);
    }
    return blend;
}

export function gainOf(before: GainStats, after: GainStats, blend: number = DEFAULT_BLEND): Gain {
    const w: number = checkBlend(blend);
    const dpsPct: number = percentChange(before.damage, after.damage);
    const ehpPct: number = percentChange(ehpOf(before), ehpOf(after));
    // A zero weight ignores its side entirely, even when that side has no percentage.
    const dpsPart: number = w === 0 ? 0 : w * dpsPct;
    const ehpPart: number = w === 1 ? 0 : (1 - w) * ehpPct;
    return { dpsPct: dpsPct, ehpPct: ehpPct, gain: dpsPart + ehpPart };
}

/** PoB generator weights for a blend: DPS w, EHP 1 − w. */
export function generatorWeights(blend: number = DEFAULT_BLEND): { readonly dpsWeight: number; readonly ehpWeight: number } {
    const w: number = checkBlend(blend);
    return { dpsWeight: w, ehpWeight: 1 - w };
}
