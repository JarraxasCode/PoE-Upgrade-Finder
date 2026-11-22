// PoB's numbers as the engine returns them (structurally the engine client's StatBlock), and small readers.
// Keys are PoB's output names (PLAN.md, "What we read"). A key PoB left out is absent.

export interface PobStats {
    readonly damage: number;
    readonly values: Readonly<Record<string, number | boolean>>;
}

export type Element = 'Fire' | 'Cold' | 'Lightning';
export const ELEMENTS: readonly Element[] = ['Fire', 'Cold', 'Lightning'];

export type Attribute = 'Str' | 'Dex' | 'Int';
export const ATTRIBUTES: readonly Attribute[] = ['Str', 'Dex', 'Int'];

/** A numeric key, or undefined when PoB left it out (or it isn't a number). */
export function stat(stats: PobStats, key: string): number | undefined {
    const v: number | boolean | undefined = stats.values[key];
    return typeof v === 'number' ? v : undefined;
}

/** Max res for an element: <El>Resist + Missing<El>Resist (PoB has no max-res key). */
export function maxRes(stats: PobStats, element: Element): number | undefined {
    const final: number | undefined = stat(stats, `${element}Resist`);
    const missing: number | undefined = stat(stats, `Missing${element}Resist`);
    return final === undefined || missing === undefined ? undefined : final + missing;
}
