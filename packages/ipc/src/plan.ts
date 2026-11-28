// The slot plan over IPC (PLAN.md, "v2a: the slot plan"): the check on every plan that comes in (the plan
// itself is in @poe-upgrade-finder/vocab), and what the plan editor gets from `slot.data`, which the renderer checks.

import { array, boolean, number, oneOf, record, string, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import {
    DEFENCE_KINDS,
    GEAR_SLOTS,
    MAX_SOCKET_VALUE,
    MAX_TOTALS,
    MOD_POSITIONS,
    MOD_RULES,
    SLOT_INFLUENCES,
    SLOT_MOD_TYPES,
    SLOT_SOURCES,
    SOCKET_ENDS,
    SOCKET_ROWS,
} from '@poe-upgrade-finder/vocab';
import type {
    AffixLimits,
    BaseAffixes,
    DefenceKind,
    DefenceRange,
    GearSlot,
    ModPick,
    ModPosition,
    PickStat,
    PickedUnique,
    PlanDefences,
    PlanSockets,
    PlanTotal,
    SlotInfluence,
    SlotModType,
    SlotPlan,
    SlotSource,
    SocketEnd,
    SocketRange,
    SocketRow,
} from '@poe-upgrade-finder/vocab';
import { readIcon } from './item-view.ts';

/** Generous caps: 3 + 3 includes, implicits and excludes stay far under them. */
const MAX_PICKS: number = 40;
const MAX_PICK_STATS: number = 4;
/** A stat the plan can name: explicit and implicit, or a source the site files apart (bench, veiled, delve); stat_ or effect_ ids. */
const STAT_ID: RegExp = /^(explicit|implicit|crafted|veiled|delve)\.(stat|effect)_\d{1,12}$/;

function exactKeys(value: unknown, path: string, keys: readonly string[]): JsonRecord {
    const r: JsonRecord = record(value, path);
    for (const key of Object.keys(r)) {
        if (!keys.includes(key)) {
            throw new ValidationError(`${path}.${key}: unexpected field`);
        }
    }
    return r;
}

function shortText(value: unknown, path: string, max: number): string {
    const s: string = string(value, path);
    if (s.trim() === '' || s.length > max || /[\u0000-\u001f]/.test(s)) {
        throw new ValidationError(`${path}: expected 1 to ${max} printable characters`);
    }
    return s;
}

function nullableText(value: unknown, path: string, max: number): string | null {
    return value === null ? null : shortText(value, path, max);
}

function rollValue(value: unknown, path: string): number {
    const n: number = number(value, path);
    if (!Number.isFinite(n) || Math.abs(n) > 1e6) {
        throw new ValidationError(`${path}: expected a finite roll value`);
    }
    return n;
}

/**
 * Whether a trade stat id is one a plan can use. Not: PoB's option stats (`explicit.stat_1190121450|1`, a
 * stat that takes an option on the site, such as the Conflux kinds; issue #64), which the plan can't filter on.
 */
export function isPlanStatId(id: string): boolean {
    return STAT_ID.test(id);
}

function statId(value: unknown, path: string): string {
    const s: string = string(value, path);
    if (!STAT_ID.test(s)) {
        throw new ValidationError(`${path}: not a trade stat id the plan can use`);
    }
    return s;
}

/** Plans saved before issue #26 may carry `allSources` (the removed "count every source" switch): read and dropped. */
function readPickStat(value: unknown, path: string): PickStat {
    const r: JsonRecord = exactKeys(value, path, ['statId', 'min', 'max', 'allSources']);
    if (r['allSources'] !== undefined) {
        boolean(r['allSources'], `${path}.allSources`);
    }
    return {
        statId: statId(r['statId'], `${path}.statId`),
        ...(r['min'] === undefined ? {} : { min: rollValue(r['min'], `${path}.min`) }),
        ...(r['max'] === undefined ? {} : { max: rollValue(r['max'], `${path}.max`) }),
    };
}

const PSEUDO_ID: RegExp = /^pseudo\.pseudo_[a-z0-9_]{1,100}$/;

function pseudoId(value: unknown, path: string): string {
    const s: string = string(value, path);
    if (!PSEUDO_ID.test(s)) {
        throw new ValidationError(`${path}: not a pseudo stat id`);
    }
    return s;
}

function readPlanTotal(value: unknown, path: string): PlanTotal {
    const r: JsonRecord = exactKeys(value, path, ['statId', 'text', 'min', 'max']);
    const text: string = string(r['text'], `${path}.text`);
    if (text.length === 0 || text.length > 200) {
        throw new ValidationError(`${path}.text: expected 1 to 200 characters`);
    }
    return {
        statId: pseudoId(r['statId'], `${path}.statId`),
        text: text,
        ...(r['min'] === undefined ? {} : { min: rollValue(r['min'], `${path}.min`) }),
        ...(r['max'] === undefined ? {} : { max: rollValue(r['max'], `${path}.max`) }),
    };
}

function readModPick(value: unknown, path: string): ModPick {
    const r: JsonRecord = exactKeys(value, path, ['position', 'group', 'influence', 'rule', 'stats']);
    const stats: readonly PickStat[] = array(r['stats'], `${path}.stats`, readPickStat);
    if (stats.length === 0 || stats.length > MAX_PICK_STATS) {
        throw new ValidationError(`${path}.stats: expected 1 to ${MAX_PICK_STATS} stats`);
    }
    return {
        position: oneOf(r['position'], `${path}.position`, MOD_POSITIONS),
        group: nullableText(r['group'], `${path}.group`, 120),
        influence: oneOf(r['influence'], `${path}.influence`, SLOT_INFLUENCES),
        rule: oneOf(r['rule'], `${path}.rule`, MOD_RULES),
        stats: stats,
    };
}

/** The largest defence value a plan takes (body armours list a few thousand at most). */
const MAX_DEFENCE: number = 100000;

function defenceValue(value: unknown, path: string): number {
    const n: number = number(value, path);
    if (!Number.isInteger(n) || n < 0 || n > MAX_DEFENCE) {
        throw new ValidationError(`${path}: expected a whole number from 0 to ${MAX_DEFENCE}`);
    }
    return n;
}

function readDefences(value: unknown, path: string): PlanDefences {
    const r: JsonRecord = exactKeys(value, path, DEFENCE_KINDS);
    const out: Partial<Record<DefenceKind, DefenceRange>> = {};
    for (const kind of DEFENCE_KINDS) {
        if (r[kind] === undefined) {
            continue;
        }
        const d: JsonRecord = exactKeys(r[kind], `${path}.${kind}`, ['min', 'max']);
        out[kind] = {
            ...(d['min'] === undefined ? {} : { min: defenceValue(d['min'], `${path}.${kind}.min`) }),
            ...(d['max'] === undefined ? {} : { max: defenceValue(d['max'], `${path}.${kind}.max`) }),
        };
    }
    return out;
}

function socketValue(value: unknown, path: string): number {
    const n: number = number(value, path);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SOCKET_VALUE) {
        throw new ValidationError(`${path}: expected a whole number from 0 to ${MAX_SOCKET_VALUE}`);
    }
    return n;
}

/** The socket filters (#58): known rows and fields, whole numbers 0 to 6, min not above max. Empty rows go. */
function readSockets(value: unknown, path: string): PlanSockets {
    const r: JsonRecord = exactKeys(value, path, SOCKET_ROWS);
    const out: Partial<Record<SocketRow, SocketRange>> = {};
    for (const row of SOCKET_ROWS) {
        if (r[row] === undefined) {
            continue;
        }
        const d: JsonRecord = exactKeys(r[row], `${path}.${row}`, SOCKET_ENDS);
        const range: Partial<Record<SocketEnd, number>> = {};
        for (const end of SOCKET_ENDS) {
            if (d[end] !== undefined) {
                range[end] = socketValue(d[end], `${path}.${row}.${end}`);
            }
        }
        if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
            throw new ValidationError(`${path}.${row}: min above max`);
        }
        if (Object.keys(range).length > 0) {
            out[row] = range;
        }
    }
    return out;
}

/** The shape only; whether the plan can exist is core's checkPlan, in main. */
export function readSlotPlan(value: unknown, path: string): SlotPlan {
    const r: JsonRecord = exactKeys(value, path, ['slot', 'itemType', 'base', 'picks', 'defences', 'totals', 'sockets', 'unique']);
    const picks: readonly ModPick[] = array(r['picks'], `${path}.picks`, readModPick);
    if (picks.length > MAX_PICKS) {
        throw new ValidationError(`${path}.picks: more than ${MAX_PICKS}`);
    }
    const itemType: string | null = nullableText(r['itemType'], `${path}.itemType`, 60);
    const base: string | null = nullableText(r['base'], `${path}.base`, 120);
    const defences: PlanDefences | undefined = r['defences'] === undefined ? undefined : readDefences(r['defences'], `${path}.defences`);
    const sockets: PlanSockets | undefined = r['sockets'] === undefined ? undefined : readSockets(r['sockets'], `${path}.sockets`);
    const totals: readonly PlanTotal[] | undefined =
        r['totals'] === undefined ? undefined : array(r['totals'], `${path}.totals`, readPlanTotal);
    if (totals !== undefined && totals.length > MAX_TOTALS) {
        throw new ValidationError(`${path}.totals: more than ${MAX_TOTALS}`);
    }
    const hasTotals: boolean = totals !== undefined && totals.length > 0;
    if (
        itemType === null &&
        (base !== null || picks.length > 0 || hasTotals || (defences !== undefined && Object.keys(defences).length > 0))
    ) {
        throw new ValidationError(`${path}.itemType: a plan with a base, mods, totals or defences needs its item type`);
    }
    const unique: PickedUnique | undefined = r['unique'] === undefined ? undefined : readPickedUnique(r['unique'], `${path}.unique`);
    if (unique !== undefined) {
        if (itemType === null) {
            throw new ValidationError(`${path}.itemType: a unique search needs its item type`);
        }
        if (base !== null || picks.length > 0 || hasTotals || (defences !== undefined && Object.keys(defences).length > 0)) {
            throw new ValidationError(`${path}: a unique search has no slot plan (no base, mods, totals or defences)`);
        }
    }
    return {
        slot: oneOf(r['slot'], `${path}.slot`, GEAR_SLOTS),
        itemType: itemType,
        base: base,
        picks: picks,
        ...(defences === undefined ? {} : { defences: defences }),
        ...(totals === undefined ? {} : { totals: totals }),
        ...(sockets === undefined ? {} : { sockets: sockets }),
        ...(unique === undefined ? {} : { unique: unique }),
    };
}

/** A picked unique (#113): PoB's name and base, the site's base name, and a Foulborn version's mutated mod; each non-empty. */
export function readPickedUnique(value: unknown, path: string): PickedUnique {
    const r: JsonRecord = exactKeys(value, path, ['name', 'base', 'tradeType', 'foulborn']);
    return {
        name: shortText(r['name'], `${path}.name`, 120),
        base: shortText(r['base'], `${path}.base`, 120),
        tradeType: shortText(r['tradeType'], `${path}.tradeType`, 120),
        ...(r['foulborn'] === undefined ? {} : { foulborn: shortText(r['foulborn'], `${path}.foulborn`, 120) }),
    };
}

/** Saved plans per slot; each must be for the slot it's saved under. */
export function readSlotPlans(value: unknown, path: string): Partial<Record<GearSlot, SlotPlan>> {
    const r: JsonRecord = record(value, path);
    const out: Partial<Record<GearSlot, SlotPlan>> = {};
    for (const [key, plan] of Object.entries(r)) {
        const slot: GearSlot = oneOf(key, `${path} key`, GEAR_SLOTS);
        const p: SlotPlan = readSlotPlan(plan, `${path}.${key}`);
        if (p.slot !== slot) {
            throw new ValidationError(`${path}.${key}: the plan is for ${p.slot}`);
        }
        out[slot] = p;
    }
    return out;
}

// The editor's data (`slot.data`) ------------------------------------------------------------------------

/** One stat of a mod or implicit, for the editor. */
export interface StatOption {
    readonly statId: string;
    /** The mod's own wording with # ("#% reduced Attribute Requirements"). */
    readonly text: string;
    /** The site's wording ("#% increased Attribute Requirements"). */
    readonly siteText: string;
    /** The site's values are negative ("reduced" against "increased"); the editor shows and takes them as the mod reads. */
    readonly negate: boolean;
    /** The lowest and highest roll over the tiers that can roll here, as the mod reads; null for a line with no number. */
    readonly roll: readonly [number, number] | null;
}

export interface TierOption {
    readonly level: number;
    readonly lines: readonly string[];
}

/** A mod that can roll on the chosen base (or any base of the type): what a plan row picks. */
export interface ModOption {
    readonly position: ModPosition;
    readonly type: SlotModType;
    readonly group: string;
    readonly influence: SlotInfluence;
    readonly source: SlotSource;
    /**
     * Where its first stat sits in the trade site's stat list (0 = top): the site lists stats by popularity, and
     * the editor orders mods the same way. Null when the site's list isn't known.
     */
    readonly rank: number | null;
    /** "#% increased Energy Shield / #% increased Stun and Block Recovery". */
    readonly text: string;
    readonly stats: readonly StatOption[];
    /** Lowest item level first. */
    readonly tiers: readonly TierOption[];
    /** PoB names of the bases that roll it. */
    readonly bases: readonly string[];
}

export interface ImplicitOption {
    readonly lines: readonly string[];
    readonly stats: readonly StatOption[];
}

export interface BaseOption {
    /** PoB's name ("Two-Toned Boots (Armour/Evasion)"). */
    readonly name: string;
    /** The site's name ("Two-Toned Boots"). */
    readonly tradeType: string;
    readonly level: number;
    /** The base's own roll [min, max] per defence it has (before quality and mods). */
    readonly defences: Readonly<Partial<Record<DefenceKind, readonly [number, number]>>>;
    readonly implicits: readonly ImplicitOption[];
    /** Influences it can have (its pools besides `none`). */
    readonly influences: readonly SlotInfluence[];
    /** How many prefixes and suffixes it takes, and its implicits' magnitude bonus per side (issue #37). */
    readonly affixes: BaseAffixes;
    /** The base's art on web.poecdn.com (the editor's base picture), or null when unknown. */
    readonly icon: string | null;
}

/** A pseudo total the plan can require (the trade site's Pseudo group, issue #26). */
export interface TotalOption {
    /** pseudo.pseudo_total_dexterity */
    readonly id: string;
    /** "+# total to Dexterity" */
    readonly text: string;
    /** What counts towards it, where measured (core's PSEUDO_TOTALS, V27); null when not known. */
    readonly counts: string | null;
}

export interface SlotEditorData {
    readonly pobVersion: string;
    readonly slot: GearSlot;
    readonly itemType: string;
    /** The base the mods are for; null: any base of the type. */
    readonly base: string | null;
    /** Every base of the type, for the base picker. */
    readonly bases: readonly BaseOption[];
    readonly mods: readonly ModOption[];
    /** Every pseudo total the site has, measured ones first. */
    readonly totals: readonly TotalOption[];
}

function nonNegative(value: unknown, path: string): number {
    const n: number = number(value, path);
    if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError(`${path}: expected a number ≥ 0`);
    }
    return n;
}

function readRoll(value: unknown, path: string): readonly [number, number] | null {
    if (value === null) {
        return null;
    }
    const pair: readonly number[] = array(value, path, rollValue);
    const lo: number | undefined = pair[0];
    const hi: number | undefined = pair[1];
    if (pair.length !== 2 || lo === undefined || hi === undefined || lo > hi) {
        throw new ValidationError(`${path}: expected [min, max]`);
    }
    return [lo, hi];
}

function readStatOption(value: unknown, path: string): StatOption {
    const r: JsonRecord = record(value, path);
    return {
        statId: statId(r['statId'], `${path}.statId`),
        text: string(r['text'], `${path}.text`),
        siteText: string(r['siteText'], `${path}.siteText`),
        negate: boolean(r['negate'], `${path}.negate`),
        roll: readRoll(r['roll'], `${path}.roll`),
    };
}

function readTierOption(value: unknown, path: string): TierOption {
    const r: JsonRecord = record(value, path);
    return { level: nonNegative(r['level'], `${path}.level`), lines: array(r['lines'], `${path}.lines`, string) };
}

export function readModOption(value: unknown, path: string): ModOption {
    const r: JsonRecord = record(value, path);
    return {
        position: oneOf(r['position'], `${path}.position`, MOD_POSITIONS),
        type: oneOf(r['type'], `${path}.type`, SLOT_MOD_TYPES),
        group: string(r['group'], `${path}.group`),
        influence: oneOf(r['influence'], `${path}.influence`, SLOT_INFLUENCES),
        source: r['source'] === undefined ? 'natural' : oneOf(r['source'], `${path}.source`, SLOT_SOURCES),
        rank: r['rank'] === undefined || r['rank'] === null ? null : nonNegative(r['rank'], `${path}.rank`),
        text: string(r['text'], `${path}.text`),
        stats: array(r['stats'], `${path}.stats`, readStatOption),
        tiers: array(r['tiers'], `${path}.tiers`, readTierOption),
        bases: array(r['bases'], `${path}.bases`, string),
    };
}

function readBaseDefences(value: unknown, path: string): Partial<Record<DefenceKind, readonly [number, number]>> {
    const r: JsonRecord = exactKeys(value, path, DEFENCE_KINDS);
    const out: Partial<Record<DefenceKind, readonly [number, number]>> = {};
    for (const kind of DEFENCE_KINDS) {
        const roll: readonly [number, number] | null = r[kind] === undefined ? null : readRoll(r[kind], `${path}.${kind}`);
        if (roll !== null) {
            out[kind] = roll;
        }
    }
    return out;
}

/** Whole numbers per side: at most 12 affixes on a side, at most 1000% more magnitude. */
function readSides(value: unknown, path: string, most: number): AffixLimits {
    const r: JsonRecord = exactKeys(value, path, ['prefix', 'suffix']);
    const side = (v: unknown, p: string): number => {
        const n: number = number(v, p);
        if (!Number.isInteger(n) || n < 0 || n > most) {
            throw new ValidationError(`${p}: expected a whole number from 0 to ${most}`);
        }
        return n;
    };
    return { prefix: side(r['prefix'], `${path}.prefix`), suffix: side(r['suffix'], `${path}.suffix`) };
}

function readBaseAffixes(value: unknown, path: string): BaseAffixes {
    const r: JsonRecord = exactKeys(value, path, ['limits', 'magnitudes']);
    return { limits: readSides(r['limits'], `${path}.limits`, 12), magnitudes: readSides(r['magnitudes'], `${path}.magnitudes`, 1000) };
}

function readBaseOption(value: unknown, path: string): BaseOption {
    const r: JsonRecord = record(value, path);
    return {
        name: string(r['name'], `${path}.name`),
        tradeType: string(r['tradeType'], `${path}.tradeType`),
        level: nonNegative(r['level'], `${path}.level`),
        defences: readBaseDefences(r['defences'], `${path}.defences`),
        implicits: array(r['implicits'], `${path}.implicits`, (v: unknown, p: string): ImplicitOption => {
            const i: JsonRecord = record(v, p);
            return { lines: array(i['lines'], `${p}.lines`, string), stats: array(i['stats'], `${p}.stats`, readStatOption) };
        }),
        influences: array(r['influences'], `${path}.influences`, (v: unknown, p: string) => oneOf(v, p, SLOT_INFLUENCES)),
        affixes: readBaseAffixes(r['affixes'], `${path}.affixes`),
        icon: r['icon'] === undefined ? null : readIcon(r['icon'], `${path}.icon`),
    };
}

function readTotalOption(value: unknown, path: string): TotalOption {
    const r: JsonRecord = record(value, path);
    return {
        id: pseudoId(r['id'], `${path}.id`),
        text: string(r['text'], `${path}.text`),
        counts: r['counts'] === null ? null : string(r['counts'], `${path}.counts`),
    };
}

export function readSlotEditorData(value: unknown, path: string): SlotEditorData {
    const r: JsonRecord = record(value, path);
    return {
        pobVersion: string(r['pobVersion'], `${path}.pobVersion`),
        slot: oneOf(r['slot'], `${path}.slot`, GEAR_SLOTS),
        itemType: string(r['itemType'], `${path}.itemType`),
        base: r['base'] === null ? null : string(r['base'], `${path}.base`),
        bases: array(r['bases'], `${path}.bases`, readBaseOption),
        mods: array(r['mods'], `${path}.mods`, readModOption),
        totals: array(r['totals'], `${path}.totals`, readTotalOption),
    };
}
