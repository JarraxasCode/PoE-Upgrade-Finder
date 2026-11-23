// The slot data the engine's `slotData` and `baseTypes` commands return (engine/lua/slotdata.lua; PLAN.md,
// Phase 6): what can roll on each base of one base type, from PoB's own mod data. Checked here as it
// comes in, like every engine message.

import { array, boolean, isRecord, number, oneOf, ProtocolError, record, string } from './check.ts';
import type { JsonRecord } from './check.ts';

/** PoB's mod types in the slot data: affixes, eldritch implicits (Exarch, Eater) and corrupted implicits. */
export type SlotModType = 'Prefix' | 'Suffix' | 'Exarch' | 'Eater' | 'Corrupted';
export const SLOT_MOD_TYPES: readonly SlotModType[] = ['Prefix', 'Suffix', 'Exarch', 'Eater', 'Corrupted'];

/** PoB's influence names (adjudicator = Warlord, basilisk = Hunter, eyrie = Redeemer); `none` is the plain pool. */
export type SlotInfluence = 'none' | 'shaper' | 'elder' | 'adjudicator' | 'basilisk' | 'crusader' | 'eyrie';
export const SLOT_INFLUENCES: readonly SlotInfluence[] = ['none', 'shaper', 'elder', 'adjudicator', 'basilisk', 'crusader', 'eyrie'];

/** One trade stat a mod carries, in the site's terms. */
export interface SlotModStat {
    /** Trade stat id, e.g. explicit.stat_2250533757. */
    readonly id: string;
    /** The site's wording, e.g. "#% increased Movement Speed". */
    readonly text: string;
    /** Index into the mod's `lines` of the line that carries it; undefined when no line could be matched. */
    readonly line: number | undefined;
    /** The line is worded the opposite way to the site's stat ("reduced" vs "increased"): its values are negative on the site. */
    readonly negate: boolean;
    /** This tier's roll in the site's values (already negated), [min, max]; undefined for a line with no number. */
    readonly range: readonly [number, number] | undefined;
}

export interface SlotMod {
    readonly type: SlotModType;
    /** Index into SlotData.families. */
    readonly family: number;
    /** Item level the tier needs. */
    readonly level: number;
    /** PoB's lines for the tier, e.g. "(39-42)% increased Energy Shield". */
    readonly lines: readonly string[];
    /** How the trade ids were found: PoB's hashes, or the lines' text against the site's list. */
    readonly via: 'hash' | 'text';
    readonly stats: readonly SlotModStat[];
}

/** Every tier of one mod: same type, PoB mod group and trade ids. */
/**
 * Where a family's mods come from (issue #32), as PoB's "Add modifier" screen has them: natural rolls, fossil
 * (a natural Delve-only affix), the crafting bench, essence-only mods, veiled (Betrayal), beastcrafts,
 * Necropolis corpses, and Delve or Incursion drop-restricted mods.
 */
export type SlotSource = 'natural' | 'fossil' | 'crafted' | 'essence' | 'veiled' | 'beast' | 'necropolis' | 'delve' | 'incursion';
export const SLOT_SOURCES: readonly SlotSource[] = [
    'natural',
    'fossil',
    'crafted',
    'essence',
    'veiled',
    'beast',
    'necropolis',
    'delve',
    'incursion',
];

export interface SlotFamily {
    readonly type: SlotModType;
    readonly group: string;
    readonly source: SlotSource;
    /** The lines with numbers as #, e.g. "#% increased Energy Shield / #% increased Stun and Block Recovery". */
    readonly text: string;
    readonly tradeIds: readonly string[];
    readonly siteTexts: readonly string[];
    /** Mod ids, lowest item level first. */
    readonly tiers: readonly string[];
}

export interface SlotImplicit {
    readonly modId: string;
    readonly lines: readonly string[];
    readonly stats: readonly SlotModStat[];
}

/** The defences a base can have, as the slot plan names them. */
export type DefenceKind = 'armour' | 'evasion' | 'energyShield' | 'ward';
export const DEFENCE_KINDS: readonly DefenceKind[] = ['armour', 'evasion', 'energyShield', 'ward'];

export interface SlotBase {
    /** PoB's name, e.g. "Two-Toned Boots (Armour/Evasion)". */
    readonly name: string;
    /** The trade site's `type` for it: PoB's name without the bracketed variant (V24). */
    readonly tradeType: string;
    readonly subType: string | undefined;
    readonly level: number;
    readonly tags: readonly string[];
    /** The base's own roll [min, max] per defence it has (PoB's armour table, before quality and mods); others missing. */
    readonly defences: Readonly<Partial<Record<DefenceKind, readonly [number, number]>>>;
    readonly implicits: readonly SlotImplicit[];
    /** Index into SlotData.pools per influence. `none` is every plain mod; an influence's pool is only the mods it adds. */
    readonly pools: Readonly<Partial<Record<SlotInfluence, number>>>;
}

export interface SlotUnmatched {
    readonly modId: string;
    readonly type: SlotModType;
    readonly lines: readonly string[];
}

export interface SlotData {
    readonly pobVersion: string;
    /** PoB's item type, e.g. "Boots", "Bow", "One Handed Sword". */
    readonly baseType: string;
    readonly bases: readonly SlotBase[];
    /** Shared mod-id lists; bases point at them. */
    readonly pools: readonly (readonly string[])[];
    readonly families: readonly SlotFamily[];
    readonly mods: Readonly<Record<string, SlotMod>>;
    /** Mods that can roll but have no trade stat id: left out of the pools (V18). */
    readonly unmatched: readonly SlotUnmatched[];
    readonly seconds: number;
}

export interface BaseTypeInfo {
    readonly baseType: string;
    readonly bases: number;
}

// Lua encodes an empty array as {}.
function list<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): readonly T[] {
    if (isRecord(value) && Object.keys(value).length === 0) {
        return [];
    }
    return array(value, path, read);
}

function index(value: unknown, path: string, size: number): number {
    const n: number = number(value, path);
    if (!Number.isInteger(n) || n < 0 || n >= size) {
        throw new ProtocolError(`${path}: expected an index below ${size}, got ${n}`);
    }
    return n;
}

function readRange(value: unknown, path: string): readonly [number, number] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const pair: readonly number[] = array(value, path, number);
    const lo: number | undefined = pair[0];
    const hi: number | undefined = pair[1];
    if (pair.length !== 2 || lo === undefined || hi === undefined || lo > hi) {
        throw new ProtocolError(`${path}: expected [min, max]`);
    }
    return [lo, hi];
}

function readStat(lineCount: number): (value: unknown, path: string) => SlotModStat {
    return (value: unknown, path: string): SlotModStat => {
        const r: JsonRecord = record(value, path);
        const line: unknown = r['line'];
        return {
            id: string(r['id'], `${path}.id`),
            text: string(r['text'], `${path}.text`),
            line: line === undefined || line === null ? undefined : index(line, `${path}.line`, lineCount),
            negate: boolean(r['negate'], `${path}.negate`),
            range: readRange(r['range'], `${path}.range`),
        };
    };
}

function readLinesAndStats(r: JsonRecord, path: string): { readonly lines: readonly string[]; readonly stats: readonly SlotModStat[] } {
    const lines: readonly string[] = list(r['lines'], `${path}.lines`, string);
    return { lines: lines, stats: list(r['stats'], `${path}.stats`, readStat(lines.length)) };
}

function readFamily(value: unknown, path: string): SlotFamily {
    const r: JsonRecord = record(value, path);
    return {
        type: oneOf(r['type'], `${path}.type`, SLOT_MOD_TYPES),
        group: string(r['group'], `${path}.group`),
        source: r['source'] === undefined ? 'natural' : oneOf(r['source'], `${path}.source`, SLOT_SOURCES),
        text: string(r['text'], `${path}.text`),
        tradeIds: list(r['tradeIds'], `${path}.tradeIds`, string),
        siteTexts: list(r['siteTexts'], `${path}.siteTexts`, string),
        tiers: list(r['tiers'], `${path}.tiers`, string),
    };
}

function readBase(poolCount: number): (value: unknown, path: string) => SlotBase {
    return (value: unknown, path: string): SlotBase => {
        const r: JsonRecord = record(value, path);
        const poolsIn: JsonRecord = record(r['pools'], `${path}.pools`);
        const pools: Partial<Record<SlotInfluence, number>> = {};
        for (const [key, v] of Object.entries(poolsIn)) {
            pools[oneOf(key, `${path}.pools key`, SLOT_INFLUENCES)] = index(v, `${path}.pools.${key}`, poolCount);
        }
        if (pools.none === undefined) {
            throw new ProtocolError(`${path}.pools: no plain pool`);
        }
        const subType: unknown = r['subType'];
        const defencesIn: JsonRecord = record(r['defences'], `${path}.defences`);
        const defences: Partial<Record<DefenceKind, readonly [number, number]>> = {};
        for (const [key, v] of Object.entries(defencesIn)) {
            const roll: readonly [number, number] | undefined = readRange(v, `${path}.defences.${key}`);
            if (roll !== undefined) {
                defences[oneOf(key, `${path}.defences key`, DEFENCE_KINDS)] = roll;
            }
        }
        return {
            name: string(r['name'], `${path}.name`),
            tradeType: string(r['tradeType'], `${path}.tradeType`),
            subType: subType === undefined || subType === null ? undefined : string(subType, `${path}.subType`),
            level: number(r['level'], `${path}.level`),
            tags: list(r['tags'], `${path}.tags`, string),
            defences: defences,
            implicits: list(r['implicits'], `${path}.implicits`, (v: unknown, p: string): SlotImplicit => {
                const i: JsonRecord = record(v, p);
                return { modId: string(i['modId'], `${p}.modId`), ...readLinesAndStats(i, p) };
            }),
            pools: pools,
        };
    };
}

/** Checks a `slotData` result, including that every index and mod id points at something. */
export function readSlotData(value: unknown): SlotData {
    const path: string = 'slotData';
    const r: JsonRecord = record(value, path);
    const families: readonly SlotFamily[] = list(r['families'], `${path}.families`, readFamily);
    const modsIn: JsonRecord = record(r['mods'], `${path}.mods`);
    const mods: Record<string, SlotMod> = {};
    for (const [modId, v] of Object.entries(modsIn)) {
        const p: string = `${path}.mods.${modId}`;
        const m: JsonRecord = record(v, p);
        mods[modId] = {
            type: oneOf(m['type'], `${p}.type`, SLOT_MOD_TYPES),
            family: index(m['family'], `${p}.family`, families.length),
            level: number(m['level'], `${p}.level`),
            via: oneOf(m['via'], `${p}.via`, ['hash', 'text'] as const),
            ...readLinesAndStats(m, p),
        };
    }
    const known = (id: unknown, p: string): string => {
        const modId: string = string(id, p);
        if (mods[modId] === undefined) {
            throw new ProtocolError(`${p}: unknown mod ${modId}`);
        }
        return modId;
    };
    families.forEach((f: SlotFamily, i: number) => {
        f.tiers.forEach((t: string, j: number) => known(t, `${path}.families[${i}].tiers[${j}]`));
    });
    const pools: readonly (readonly string[])[] = list(r['pools'], `${path}.pools`, (v: unknown, p: string) => list(v, p, known));
    return {
        pobVersion: string(r['pobVersion'], `${path}.pobVersion`),
        baseType: string(r['baseType'], `${path}.baseType`),
        bases: list(r['bases'], `${path}.bases`, readBase(pools.length)),
        pools: pools,
        families: families,
        mods: mods,
        unmatched: list(r['unmatched'], `${path}.unmatched`, (v: unknown, p: string): SlotUnmatched => {
            const u: JsonRecord = record(v, p);
            return {
                modId: string(u['modId'], `${p}.modId`),
                type: oneOf(u['type'], `${p}.type`, SLOT_MOD_TYPES),
                lines: list(u['lines'], `${p}.lines`, string),
            };
        }),
        seconds: number(r['seconds'], `${path}.seconds`),
    };
}

export function readBaseTypes(value: unknown): { readonly types: readonly BaseTypeInfo[] } {
    const r: JsonRecord = record(value, 'baseTypes');
    return {
        types: list(r['types'], 'baseTypes.types', (v: unknown, p: string): BaseTypeInfo => {
            const t: JsonRecord = record(v, p);
            return { baseType: string(t['baseType'], `${p}.baseType`), bases: number(t['bases'], `${p}.bases`) };
        }),
    };
}
