// Which of an item's lines met each of the run's requirements, and that it has none of the excluded stats or
// defences outside their ranges (issue #6). Pure and for showing only: the site already filtered every result
// on these, and PoB scores the item as it is. A mismatch here points at a reading of the site's rules that is
// off, so it is shown, not acted on.
//
// The site's rules this follows:
// - `explicit.stat_X` counts the stat on explicit, crafted and fractured lines (V24, decision 9), summed over
//   every line that carries it (decision 10); `implicit.stat_X` counts implicit lines only.
// - A pseudo total counts every line kind with each source's factor (V27, decision 14): half of Strength
//   towards life, +all Attributes towards each attribute.
// - A "reduced" line on an "increased" stat is negative on the site (decision 11).
// - Defences are compared at 20% quality: listed × 1.2 / (1 + quality) for an item below 20% (decision 19).
//   An item above 20% is compared as listed (seen on a live run: 702 Armour at 24% passed a min of 700).

import { SOCKET_COLOURS } from '@poe-upgrade-finder/vocab';
import type { DefenceKind, SocketColour, SocketRange, SocketRow } from '@poe-upgrade-finder/vocab';
import type { StatLine, StatLineKind } from '@poe-upgrade-finder/trade';
import { PSEUDO_TOTALS } from './pseudo-totals.ts';
import type { PseudoTotal } from './pseudo-totals.ts';
import type { SearchDefence, SearchExclusion, SearchRequirement, SearchSockets } from './spec.ts';

/** met: as the site should have it; missed: by this reading it doesn't; unknown: the item's lines aren't known. */
export type MatchStatus = 'met' | 'missed' | 'unknown';

export interface MatchedLine {
    readonly text: string;
    readonly kind: StatLineKind;
    /** The line's value in the site's terms (negative for a "reduced" line on an "increased" stat); null: no number. */
    readonly value: number | null;
    /** What the line counts for in a total: 1, or 0.5 for Strength towards life. */
    readonly factor: number;
}

export interface RequirementMatch {
    readonly statId: string;
    readonly origin: SearchRequirement['origin'];
    readonly label: string;
    readonly min?: number;
    readonly max?: number;
    /** The item's total in the label's terms (a "reduced" include reads positive); null when no line has a number. */
    readonly total: number | null;
    readonly status: MatchStatus;
    readonly lines: readonly MatchedLine[];
}

export interface ExclusionMatch {
    readonly statId: string;
    readonly label: string;
    /** met: the item has no line with the stat. */
    readonly status: MatchStatus;
    readonly lines: readonly MatchedLine[];
}

export interface DefenceMatch {
    readonly defence: DefenceKind;
    readonly label: string;
    readonly min?: number;
    readonly max?: number;
    /** The item's value as listed (0 when it has none); null when the item's properties aren't known. */
    readonly listed: number | null;
    /** The item's quality in percent (0 when none). */
    readonly quality: number;
    /** The value the site compares: at 20% quality for an item below it. */
    readonly compared: number | null;
    readonly status: MatchStatus;
}

/** One socket filter row (#58) against the item's sockets. */
export interface SocketMatch {
    readonly row: SocketRow;
    readonly label: string;
    /** "6 sockets, 5 linked"; null when the listing gave no socket data. */
    readonly value: string | null;
    readonly status: MatchStatus;
}

export interface PlanMatch {
    readonly requirements: readonly RequirementMatch[];
    readonly exclusions: readonly ExclusionMatch[];
    readonly defences: readonly DefenceMatch[];
    readonly sockets: readonly SocketMatch[];
}

/** What the matcher reads of the spec. */
export interface MatchSpec {
    readonly requirements: readonly SearchRequirement[];
    readonly exclusions: readonly SearchExclusion[];
    readonly defences: readonly SearchDefence[];
    /** Missing: none (callers from before #58). */
    readonly sockets?: readonly SearchSockets[];
}

/** What it reads of the item: its lines with their stats, and its property lines ("Armour: 418", "Quality: +12%"). */
export interface MatchItem {
    /** Undefined when the listing didn't tie its lines to stats. */
    readonly statLines: readonly StatLine[] | undefined;
    /** Undefined when the listing had no tooltip data. */
    readonly properties: readonly string[] | undefined;
    /** The sockets as the tooltip writes them ("R-G-B B"); missing when the listing had no tooltip data. */
    readonly sockets?: string | undefined;
}

export const NO_PLAN_MATCH: PlanMatch = { requirements: [], exclusions: [], defences: [], sockets: [] };

const EPSILON: number = 1e-9;
const DOWN: RegExp = /\b(?:reduced|less)\b/i;

/** "+14 to maximum Life" → 14, "Adds 10 to 20 Fire Damage" → 15 (the site averages), no number → null. */
export function lineNumber(text: string): number | null {
    const adds: RegExpExecArray | null = /\bAdds (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?)\b/i.exec(text);
    if (adds !== null) {
        return (Number(adds[1]) + Number(adds[2])) / 2;
    }
    const n: RegExpExecArray | null = /[+-]?\d+(?:\.\d+)?/.exec(text);
    return n === null ? null : Number(n[0]);
}

/** A line's value on the site: negative when it is worded the other way to the site's stat. */
export function lineValue(text: string, siteText: string | undefined): number | null {
    const n: number | null = lineNumber(text);
    if (n === null) {
        return null;
    }
    const siteDown: boolean = siteText !== undefined && DOWN.test(siteText);
    return DOWN.test(text) !== siteDown ? -n : n;
}

/** "explicit.stat_X" → ["explicit", "stat_X"]. */
function splitId(statId: string): readonly [string, string] {
    const dot: number = statId.indexOf('.');
    return dot < 0 ? ['', statId] : [statId.slice(0, dot), statId.slice(dot + 1)];
}

/** The line kinds a stat id's prefix matches on the site. */
function kindsFor(prefix: string): readonly StatLineKind[] {
    switch (prefix) {
        case 'explicit':
            return ['explicit', 'crafted', 'fractured'];
        case 'implicit':
            return ['implicit'];
        case 'crafted':
            return ['crafted'];
        case 'fractured':
            return ['fractured'];
        case 'enchant':
            return ['enchant'];
        default:
            return [];
    }
}

/** Every line kind but enchants counts towards a pseudo total (V27). */
const PSEUDO_KINDS: readonly StatLineKind[] = ['implicit', 'explicit', 'crafted', 'fractured', 'scourge', 'crucible'];

const PSEUDO_BY_ID: ReadonlyMap<string, PseudoTotal> = new Map<string, PseudoTotal>(PSEUDO_TOTALS.map((p: PseudoTotal) => [p.id, p]));

/** The lines that count for a stat id, each with its factor; undefined when the id's rule isn't known. */
function linesFor(statId: string, lines: readonly StatLine[], siteText: string | undefined): MatchedLine[] | undefined {
    const [prefix, hash] = splitId(statId);
    const matched = (l: StatLine, factor: number): MatchedLine => ({
        text: l.text,
        kind: l.kind,
        value: lineValue(l.text, siteText),
        factor: factor,
    });
    if (prefix === 'pseudo') {
        const total: PseudoTotal | undefined = PSEUDO_BY_ID.get(statId);
        if (total === undefined) {
            return undefined;
        }
        const out: MatchedLine[] = [];
        for (const l of lines) {
            const source = total.sources.find((s) => s.hash === splitId(l.statId)[1]);
            if (source !== undefined && PSEUDO_KINDS.includes(l.kind)) {
                out.push(matched(l, source.factor));
            }
        }
        return out;
    }
    const kinds: readonly StatLineKind[] = kindsFor(prefix);
    if (kinds.length === 0) {
        return undefined;
    }
    return lines.filter((l: StatLine) => kinds.includes(l.kind) && splitId(l.statId)[1] === hash).map((l: StatLine) => matched(l, 1));
}

function inRange(value: number, min: number | undefined, max: number | undefined): boolean {
    return (min === undefined || value >= min - EPSILON) && (max === undefined || value <= max + EPSILON);
}

function range(r: { readonly min?: number | undefined; readonly max?: number | undefined }): {
    readonly min?: number;
    readonly max?: number;
} {
    return { ...(r.min === undefined ? {} : { min: r.min }), ...(r.max === undefined ? {} : { max: r.max }) };
}

function matchRequirement(r: SearchRequirement, lines: readonly StatLine[] | undefined): RequirementMatch {
    const base = { statId: r.statId, origin: r.origin, label: r.label, ...range(r) };
    const found: MatchedLine[] | undefined = lines === undefined ? undefined : linesFor(r.statId, lines, r.siteText);
    if (found === undefined) {
        return { ...base, total: null, status: 'unknown', lines: [] };
    }
    const numbered: readonly MatchedLine[] = found.filter((l: MatchedLine) => l.value !== null);
    const siteTotal: number | null =
        numbered.length === 0 ? null : numbered.reduce((sum: number, l: MatchedLine) => sum + (l.value ?? 0) * l.factor, 0);
    let status: MatchStatus;
    if (found.length === 0) {
        status = 'missed';
    } else if (r.min === undefined && r.max === undefined) {
        status = 'met';
    } else {
        status = siteTotal !== null && inRange(siteTotal, r.min, r.max) ? 'met' : 'missed';
    }
    const total: number | null = siteTotal === null ? null : r.negated === true ? -siteTotal : siteTotal;
    return { ...base, total: total, status: status, lines: found };
}

function matchExclusion(e: SearchExclusion, lines: readonly StatLine[] | undefined): ExclusionMatch {
    const found: MatchedLine[] | undefined = lines === undefined ? undefined : linesFor(e.statId, lines, undefined);
    return {
        statId: e.statId,
        label: e.label,
        status: found === undefined ? 'unknown' : found.length === 0 ? 'met' : 'missed',
        lines: found ?? [],
    };
}

/** The tooltip's property names for each defence. */
const DEFENCE_PROPERTY: Readonly<Record<DefenceKind, string>> = {
    armour: 'Armour',
    evasion: 'Evasion Rating',
    energyShield: 'Energy Shield',
    ward: 'Ward',
};

/** A property line's whole-number value ("Armour: 418" → 418), or undefined when the item has no such line. */
function propertyValue(properties: readonly string[], name: string): number | undefined {
    for (const p of properties) {
        const m: RegExpExecArray | null = new RegExp(`^${name}: \\+?(\\d+)`).exec(p.trim());
        if (m !== null) {
            return Number(m[1]);
        }
    }
    return undefined;
}

/** The value the site compares a defence at (decision 19): raised to 20% quality, never lowered. */
export function comparedDefence(listed: number, qualityPct: number): number {
    return qualityPct < 20 ? (listed * 1.2) / (1 + qualityPct / 100) : listed;
}

function matchDefence(d: SearchDefence, properties: readonly string[] | undefined): DefenceMatch {
    const base = { defence: d.defence, label: d.label, ...range(d) };
    if (properties === undefined) {
        return { ...base, listed: null, quality: 0, compared: null, status: 'unknown' };
    }
    const listed: number = propertyValue(properties, DEFENCE_PROPERTY[d.defence]) ?? 0;
    const quality: number = propertyValue(properties, 'Quality') ?? 0;
    const compared: number = comparedDefence(listed, quality);
    return { ...base, listed: listed, quality: quality, compared: compared, status: inRange(compared, d.min, d.max) ? 'met' : 'missed' };
}

/** An item's sockets as the site counts them (V30): every socket (abyssal ones too), the largest linked group. */
export interface SocketCounts {
    readonly sockets: number;
    readonly links: number;
    /** R, G, B and W over every socket, and in the largest linked group (per colour, its best group of that size). */
    readonly colours: Readonly<Record<SocketRow, Readonly<Record<SocketColour, number>>>>;
}

function noColours(): Record<SocketColour, number> {
    return { r: 0, g: 0, b: 0, w: 0 };
}

/** From the tooltip's socket text: "-" links two sockets, a space starts a new group ("R-G-A B"). */
export function socketCounts(text: string): SocketCounts {
    const groups: string[][] = text
        .trim()
        .split(/\s+/)
        .filter((g: string) => g.length > 0)
        .map((g: string) => g.split('-').filter((c: string) => c.length > 0));
    const all: Record<SocketColour, number> = noColours();
    let sockets: number = 0;
    let links: number = 0;
    for (const g of groups) {
        sockets += g.length;
        links = Math.max(links, g.length);
        for (const c of g) {
            const colour: string = c.toLowerCase();
            if ((SOCKET_COLOURS as readonly string[]).includes(colour)) {
                all[colour as SocketColour] += 1;
            }
        }
    }
    const linked: Record<SocketColour, number> = noColours();
    for (const g of groups.filter((x: string[]) => x.length === links)) {
        for (const colour of SOCKET_COLOURS) {
            linked[colour] = Math.max(linked[colour], g.filter((c: string) => c.toLowerCase() === colour).length);
        }
    }
    return { sockets: sockets, links: links, colours: { sockets: all, links: linked } };
}

function fitsSockets(counts: SocketCounts, row: SocketRow, range: SocketRange): boolean {
    const n: number = row === 'sockets' ? counts.sockets : counts.links;
    const colours: Readonly<Record<SocketColour, number>> = counts.colours[row];
    return inRange(n, range.min, range.max) && SOCKET_COLOURS.every((c: SocketColour) => colours[c] >= (range[c] ?? 0));
}

function matchSockets(s: SearchSockets, text: string | undefined): SocketMatch {
    const base = { row: s.row, label: s.label };
    if (text === undefined) {
        return { ...base, value: null, status: 'unknown' };
    }
    const counts: SocketCounts = socketCounts(text);
    // The tooltip writes "" both for an item with no sockets and for a listing that left them out: only a filter
    // that no sockets meets can say so; otherwise it isn't known.
    if (counts.sockets === 0 && !fitsSockets(counts, s.row, s.range)) {
        return { ...base, value: null, status: 'unknown' };
    }
    const value: string = `${counts.sockets} socket${counts.sockets === 1 ? '' : 's'}, ${counts.links} linked`;
    return { ...base, value: value, status: fitsSockets(counts, s.row, s.range) ? 'met' : 'missed' };
}

/** The item against the spec's requirements, exclusions and defences. */
export function matchPlan(spec: MatchSpec, item: MatchItem): PlanMatch {
    const lines: readonly StatLine[] | undefined = item.statLines === undefined || item.statLines.length === 0 ? undefined : item.statLines;
    return {
        requirements: spec.requirements.map((r: SearchRequirement) => matchRequirement(r, lines)),
        exclusions: spec.exclusions.map((e: SearchExclusion) => matchExclusion(e, lines)),
        defences: spec.defences.map((d: SearchDefence) => matchDefence(d, item.properties)),
        sockets: (spec.sockets ?? []).map((s: SearchSockets) => matchSockets(s, item.sockets)),
    };
}
