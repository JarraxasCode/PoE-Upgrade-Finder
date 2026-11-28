// The slot plan (PLAN.md, "v2a: the slot plan" and "Phase 6"): what to search for on one slot, as plain data
// that knows nothing about the run around it. The base, implicits, prefixes and suffixes (3 and 3, unless the
// base says otherwise: issue #37), each mod Include (results must have it) or Exclude (results never have it).
// This file analyses a plan against PoB's slot data once (analysePlan): the check, and the pruning of any
// weight list to what can still be on a result. The spec is built from it in slot-spec.ts.
//
// What the site can return decides the pruning, not what the user picked. An include's range is on the
// item's total for its stat (V24, decision 10), so "#% increased Energy Shield" can be met by the pure mod or
// by a hybrid that also carries it. A mod group or an affix side only counts as taken when every mod that
// could carry an included stat is in that group or on that side. When in doubt a weight is kept: an extra
// weight costs 4 complexity, a wrong prune hides items without a word.
//
// Assumed (from how the game works, not from PoB's data, which has no bench crafts): a crafted mod sits on
// the same side and in the same group as the natural mod with its stat, so the group and side rules hold for
// crafted lines too (they meet includes and excludes, V24 decision 9). An exclude the base can't roll is
// still sent, since a craft could add the stat.
//
// An exclude keeps the mod off the results, not its stats (#38). The site filters stats only (G19), so a pure
// (one-stat) exclude is a Not group on its stat, and a hybrid exclude is checked after the fetch on the mod
// indices each listing gives (excluded-mods.ts). Only a Not group's stats are pruned from the weights.

import type { SlotBase, SlotData, SlotFamily, SlotImplicit, SlotMod, SlotModStat } from '@poe-upgrade-finder/engine-client';
import {
    DEFENCE_KINDS,
    DEFENCE_NAMES,
    fitsBeside,
    hasDefences,
    hasSockets,
    isGenericType,
    MAX_INFLUENCES,
    MAX_TOTALS,
    memberTypes,
    offHandTypes,
    SLOT_INFLUENCES,
    slotTakes,
} from '@poe-upgrade-finder/vocab';
import type {
    AffixLimits,
    DefenceKind,
    DefenceRange,
    GearSlot,
    ModPick,
    ModPosition,
    PickStat,
    PlanDefences,
    PlanTotal,
    PruneReason,
    SlotInfluence,
    SlotModType,
    SlotPlan,
} from '@poe-upgrade-finder/vocab';
import { baseAffixes } from './affix-limits.ts';
import type { PrunedWeight, WeightedStat } from './spec.ts';

/** The plan's defences that set an end, in order. */
export function planDefences(plan: SlotPlan): readonly (readonly [DefenceKind, DefenceRange])[] {
    const out: [DefenceKind, DefenceRange][] = [];
    for (const kind of DEFENCE_KINDS) {
        const range: DefenceRange | undefined = plan.defences?.[kind];
        if (range !== undefined && (range.min !== undefined || range.max !== undefined)) {
            out.push([kind, range]);
        }
    }
    return out;
}

/**
 * The defences a local stat adds to, from the site's wording ("#% increased Armour and Energy Shield (Local)").
 * A local defence mod only rolls on a base that has that defence, so a result with it has the defence.
 */
export function localDefences(siteText: string): readonly DefenceKind[] {
    const text: string = siteText.toLowerCase();
    if (!text.includes('(local)')) {
        return [];
    }
    const out: DefenceKind[] = [];
    if (/\barmour\b/.test(text)) {
        out.push('armour');
    }
    if (/\bevasion\b/.test(text)) {
        out.push('evasion');
    }
    if (text.includes('energy shield')) {
        out.push('energyShield');
    }
    if (/\bward\b/.test(text)) {
        out.push('ward');
    }
    return out;
}

/** Whether a base can have these defences: none at max 0 that it has, none with a min above 0 that it lacks. */
function baseFits(base: SlotBase, defences: PlanDefences | undefined): boolean {
    for (const kind of DEFENCE_KINDS) {
        const range: DefenceRange | undefined = defences?.[kind];
        const has: boolean = base.defences[kind] !== undefined;
        if (range?.max === 0 && has) {
            return false;
        }
        if (range?.min !== undefined && range.min > 0 && !has) {
            return false;
        }
    }
    return true;
}

/** The plan's totals (none when missing). */
export function planTotals(plan: SlotPlan): readonly PlanTotal[] {
    return plan.totals ?? [];
}

/** An empty plan searches exactly as v0.1 did (decision 8). Socket filters (#58) make a plan non-empty. */
export function isEmptyPlan(plan: SlotPlan): boolean {
    return hasNoMods(plan) && !hasSockets(plan);
}

/** Nothing for the slot data to check: no item type, base, mods, defences or totals (socket filters need none). */
function hasNoMods(plan: SlotPlan): boolean {
    return (
        plan.itemType === null &&
        plan.base === null &&
        plan.picks.length === 0 &&
        planDefences(plan).length === 0 &&
        planTotals(plan).length === 0
    );
}

export type PlanProblemCode =
    | 'slot-mismatch'
    | 'unknown-unique'
    | 'no-slot-data'
    | 'slot-data-mismatch'
    | 'unknown-base'
    | 'empty-pick'
    | 'bad-range'
    | 'too-many-prefixes'
    | 'too-many-suffixes'
    | 'too-many-affixes'
    | 'same-group'
    | 'include-and-exclude'
    | 'cannot-roll'
    | 'eldritch-limit'
    | 'too-many-influences'
    | 'wrong-slot'
    | 'no-defences'
    | 'bad-defence'
    | 'defence-always'
    | 'defence-never'
    | 'defences-no-base'
    | 'include-and-defence'
    | 'bad-total'
    | 'conflicting-ranges'
    | 'offhand-mismatch'
    | 'generic-type';

export type PlanNoteCode = 'redundant-exclude' | 'shared-stat' | 'offhand-removed' | 'exclude-hybrids';

/**
 * A hybrid exclude (#38): an affix mod with two or more stats, kept off the results after the fetch rather than
 * by a Not group on its stats. Implicit excludes stay Not groups.
 */
export function isHybridExclude(pick: ModPick): boolean {
    return pick.rule === 'exclude' && pick.position !== 'implicit' && pick.stats.length > 1;
}

/** Whether one mod of `include` would carry every stat of `exclude` (so a hybrid exclude drops it, #38). */
export function carriesAll(include: ModPick, exclude: ModPick): boolean {
    return exclude.stats.every((e: PickStat) => include.stats.some((s: PickStat) => s.statId === e.statId));
}

/** The excludes that go in the query's Not group: every exclude but the hybrids. */
export function notGroupExcludes(picks: readonly ModPick[]): readonly ModPick[] {
    return picks.filter((p: ModPick) => p.rule === 'exclude' && !isHybridExclude(p));
}

/** What the build holds in its weapon slots, for the weapon-hand rules (#39). */
export interface PlanGear {
    /** PoB's item type in Weapon 1 ("Bow", "Wand"); null when it's empty. */
    readonly weapon1Type: string | null;
    /** PoB's item type in Weapon 2 ("Shield", "Quiver"); null when it's empty. */
    readonly weapon2Type: string | null;
}

function aOrAn(word: string): string {
    // "One Handed" reads "won": a One Handed Sword.
    return /^[AEIOU]/.test(word) && !word.startsWith('One ') ? `an ${word}` : `a ${word}`;
}

function capitalised(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The weapon-hand rules (#39, the game's: poe1-mechanics G6). Weapon 2 takes only what fits beside the build's
 * Weapon 1, so a plan that doesn't fit (or any Weapon 2 plan beside a two-hander) is refused: PoB wouldn't
 * equip a single result. A Weapon 1 plan for a type that can't be held beside the build's Weapon 2 is fine,
 * and noted: its results are scored with Weapon 2 emptied. No gear (unknown): no check.
 */
function handIssues(
    plan: SlotPlan,
    gear: PlanGear | undefined,
): { readonly problem?: PlanIssue<PlanProblemCode>; readonly note?: PlanIssue<PlanNoteCode> } {
    if (gear === undefined) {
        return {};
    }
    if (plan.slot === 'Weapon 2') {
        const allowed: readonly string[] = offHandTypes(gear.weapon1Type);
        if (allowed.length === 0) {
            return {
                problem: {
                    code: 'offhand-mismatch',
                    pick: undefined,
                    text: `Weapon 1 is two-handed (${aOrAn(gear.weapon1Type ?? 'weapon')}): nothing goes in Weapon 2`,
                },
            };
        }
        if (plan.itemType !== null && !allowed.includes(plan.itemType)) {
            const beside: string = gear.weapon1Type === null ? 'an empty Weapon 1' : `${aOrAn(gear.weapon1Type)} in Weapon 1`;
            return {
                problem: {
                    code: 'offhand-mismatch',
                    pick: undefined,
                    text: `${capitalised(aOrAn(plan.itemType))} can't be held beside ${beside}: Weapon 2 takes ${allowed.join(', ')}`,
                },
            };
        }
    }
    if (plan.slot === 'Weapon 1' && plan.itemType !== null && gear.weapon2Type !== null && isGenericType(plan.itemType)) {
        const note: PlanIssue<PlanNoteCode> | undefined = genericHandNote(plan.itemType, gear.weapon2Type);
        return note === undefined ? {} : { note: note };
    }
    if (plan.slot === 'Weapon 1' && plan.itemType !== null && gear.weapon2Type !== null && !fitsBeside(plan.itemType, gear.weapon2Type)) {
        return {
            note: {
                code: 'offhand-removed',
                pick: undefined,
                text:
                    `${capitalised(aOrAn(plan.itemType))} can't be held beside your ${gear.weapon2Type.toLowerCase()}: results are scored with ` +
                    'Weapon 2 empty, so their gain includes losing it',
            },
        };
    }
    return {};
}

/**
 * A generic Weapon 1 type beside the build's Weapon 2 (#39): its results that can't be held there (two-handers
 * beside a shield, say) are scored with Weapon 2 emptied. Undefined when every result fits.
 */
function genericHandNote(itemType: string, weapon2Type: string): PlanIssue<PlanNoteCode> | undefined {
    const misfits: readonly string[] = memberTypes(itemType).filter((t: string) => !fitsBeside(t, weapon2Type));
    if (misfits.length === 0) {
        return undefined;
    }
    const yours: string = `your ${weapon2Type.toLowerCase()}`;
    const loss: string = 'Weapon 2 empty, so their gain includes losing it';
    if (misfits.length === memberTypes(itemType).length) {
        return {
            code: 'offhand-removed',
            pick: undefined,
            text: `No ${itemType.toLowerCase()} can be held beside ${yours}: results are scored with ${loss}`,
        };
    }
    const shown: readonly string[] = misfits.slice(0, 3);
    const more: number = misfits.length - shown.length;
    const list: string = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(' and ');
    return {
        code: 'offhand-removed',
        pick: undefined,
        text: `Some results can't be held beside ${yours} (${list}): those are scored with ${loss}. Results may look odd next to the rest`,
    };
}

export interface PlanIssue<C extends string> {
    readonly code: C;
    /** Index into the plan's picks, when the issue is about one. */
    readonly pick: number | undefined;
    readonly text: string;
}

export interface PlanCheck {
    readonly ok: boolean;
    /** Anything here refuses the plan. */
    readonly problems: readonly PlanIssue<PlanProblemCode>[];
    /** Changes made to the plan, for the user and the log. */
    readonly notes: readonly PlanIssue<PlanNoteCode>[];
    /** The plan as it will be searched: redundant excludes dropped. */
    readonly plan: SlotPlan;
    /** Influences the item must have, from the influenced includes. */
    readonly influences: readonly SlotInfluence[];
}

const AFFIX_TYPES: readonly SlotModType[] = ['Prefix', 'Suffix'];

/** Which of PoB's mod types fill each position of the plan. */
export type PositionTypes = Readonly<Record<ModPosition, readonly SlotModType[]>>;

/** The positions on every item type today; the off-hand rules (#39) may give an item type its own. */
export const POSITION_TYPES: PositionTypes = {
    prefix: ['Prefix'],
    suffix: ['Suffix'],
    implicit: ['Exarch', 'Eater', 'Corrupted'],
};

type Side = 'Prefix' | 'Suffix';
const SIDES: readonly Side[] = ['Prefix', 'Suffix'];

function limitOf(limits: AffixLimits, side: Side): number {
    return side === 'Prefix' ? limits.prefix : limits.suffix;
}

const SIDE_WORDS: Readonly<Record<Side, string>> = { Prefix: 'prefix', Suffix: 'suffix' };

interface FamilyRef {
    readonly index: number;
    readonly family: SlotFamily;
}

/** Where a picked mod was found in the slot data: an affix or eldritch/corrupted family, or a base implicit. */
export type PickSource =
    { readonly kind: 'family'; readonly ref: FamilyRef } | { readonly kind: 'implicit'; readonly implicit: SlotImplicit };

/** How one picked stat reads: its words for labels, and whether the site's values are negative. */
export interface PickStatInfo {
    readonly text: string;
    readonly negate: boolean;
}

/** Lookups over one base type's slot data, for the chosen base (or every base of the type). */
export class PlanSlotData {
    public readonly data: SlotData;
    public readonly bases: readonly SlotBase[];
    private readonly siteTexts: ReadonlyMap<string, string>;
    private readonly positionTypes: PositionTypes;

    /** With defences: only the bases that can have them (a max of 0 on Energy Shield leaves the bases without it). */
    public constructor(data: SlotData, baseName: string | null, defences?: PlanDefences, positionTypes: PositionTypes = POSITION_TYPES) {
        this.data = data;
        this.positionTypes = positionTypes;
        this.bases = data.bases.filter((b: SlotBase) => (baseName === null || b.name === baseName) && baseFits(b, defences));
        const texts: Map<string, string> = new Map<string, string>();
        for (const f of data.families) {
            f.tradeIds.forEach((id: string, i: number) => {
                const text: string | undefined = f.siteTexts[i];
                if (text !== undefined && !texts.has(id)) {
                    texts.set(id, text);
                }
            });
        }
        for (const b of data.bases) {
            for (const imp of b.implicits) {
                for (const s of imp.stats) {
                    if (!texts.has(s.id)) {
                        texts.set(s.id, s.text);
                    }
                }
            }
        }
        this.siteTexts = texts;
    }

    /** The families that can roll on the bases from these pools ('all': every pool the base has). */
    public reachable(pools: readonly SlotInfluence[] | 'all'): ReadonlyMap<number, SlotFamily> {
        const out: Map<number, SlotFamily> = new Map<number, SlotFamily>();
        for (const base of this.bases) {
            for (const influence of SLOT_INFLUENCES) {
                const poolIndex: number | undefined = base.pools[influence];
                if (poolIndex === undefined || (pools !== 'all' && !pools.includes(influence))) {
                    continue;
                }
                for (const modId of this.data.pools[poolIndex] ?? []) {
                    const familyIndex: number | undefined = this.data.mods[modId]?.family;
                    const family: SlotFamily | undefined = familyIndex === undefined ? undefined : this.data.families[familyIndex];
                    if (familyIndex !== undefined && family !== undefined) {
                        out.set(familyIndex, family);
                    }
                }
            }
        }
        return out;
    }

    /** Where a pick can come from on these bases, in its own pool; undefined when it can't roll there. */
    public sourceOf(pick: ModPick): PickSource | undefined {
        const statIds: readonly string[] = pick.stats.map((s: PickStat) => s.statId);
        if (pick.group === null) {
            if (pick.position !== 'implicit') {
                return undefined;
            }
            for (const base of this.bases) {
                const implicit: SlotImplicit | undefined = base.implicits.find((imp: SlotImplicit) =>
                    statIds.every((id: string) => imp.stats.some((s: SlotModStat) => s.id === id)),
                );
                if (implicit !== undefined) {
                    return { kind: 'implicit', implicit: implicit };
                }
            }
            return undefined;
        }
        const types: readonly SlotModType[] = this.positionTypes[pick.position];
        // A plain pick comes from the plain pool; an influenced one from the mods its influence adds.
        for (const [index, family] of this.reachable([pick.influence])) {
            if (family.group === pick.group && types.includes(family.type) && statIds.every((id: string) => family.tradeIds.includes(id))) {
                return { kind: 'family', ref: { index: index, family: family } };
            }
        }
        return undefined;
    }

    /** Words and sign for one stat of a pick (the line as PoB words it for affixes, the site's text otherwise). */
    public statInfo(pick: ModPick, statId: string): PickStatInfo {
        const source: PickSource | undefined = this.sourceOf(pick);
        const fallback: string = this.siteText(statId);
        if (source === undefined) {
            return { text: fallback, negate: false };
        }
        if (source.kind === 'implicit') {
            const s: SlotModStat | undefined = source.implicit.stats.find((x: SlotModStat) => x.id === statId);
            return { text: s?.text ?? fallback, negate: s?.negate ?? false };
        }
        const family: SlotFamily = source.ref.family;
        for (const modId of family.tiers) {
            const mod: SlotMod | undefined = this.data.mods[modId];
            const s: SlotModStat | undefined = mod?.stats.find((x: SlotModStat) => x.id === statId);
            if (mod !== undefined && s !== undefined) {
                const segments: readonly string[] = family.text.split(' / ');
                const line: string | undefined =
                    s.line === undefined || segments.length !== mod.lines.length ? undefined : segments[s.line];
                return { text: line ?? s.text, negate: s.negate };
            }
        }
        return { text: fallback, negate: false };
    }

    /** The site's wording for a stat id, or the id itself. */
    public siteText(statId: string): string {
        return this.siteTexts.get(statId) ?? statId;
    }
}

/**
 * A side no result can add a mod to, over every base that can hold the plan's includes: the includes fill it
 * ('filled'), or none of those bases has that side at all ('none', a Ratcheting Ring's prefixes).
 */
interface FullSide {
    readonly state: 'filled' | 'none';
    /** The side's limit when every such base has the same one, for the words. */
    readonly limit: number | undefined;
}

/** Why no result can have a stat, or undefined when one can. */
interface Blocked {
    readonly by: 'group' | 'side' | 'both';
    readonly sides: ReadonlyMap<Side, FullSide>;
}

/** Which mods can still be on a result, given the plan's includes. */
class RoomFacts {
    private readonly families: readonly SlotFamily[];
    private readonly includeStats: ReadonlySet<string>;
    private readonly pinnedGroups: ReadonlySet<string>;
    private readonly fullSides: ReadonlyMap<Side, FullSide>;

    /** `limits`: the affix limits of each base that can hold the includes. */
    public constructor(view: PlanSlotData, plan: SlotPlan, influences: readonly SlotInfluence[], limits: readonly AffixLimits[]) {
        // With two influences pinned, only their pools are left; otherwise any influence could still be on the item.
        const pools: readonly SlotInfluence[] | 'all' = influences.length >= MAX_INFLUENCES ? ['none', ...influences] : 'all';
        this.families = [...view.reachable(pools).values()].filter((f: SlotFamily) => AFFIX_TYPES.includes(f.type));
        const includes: readonly ModPick[] = plan.picks.filter((p: ModPick) => p.rule === 'include');
        // Every stat that can meet an include.
        this.includeStats = new Set<string>(includes.flatMap((p: ModPick) => p.stats.map((s: PickStat) => s.statId)));
        const pinned: Set<string> = new Set<string>();
        const consumed: Record<Side, number> = { Prefix: 0, Suffix: 0 };
        for (const pick of includes) {
            if (pick.position === 'implicit') {
                continue;
            }
            const others: ReadonlySet<string> = new Set<string>(
                includes.filter((p: ModPick) => p !== pick).flatMap((p: ModPick) => p.stats.map((s: PickStat) => s.statId)),
            );
            const sides: Set<Side> = new Set<Side>();
            for (const s of pick.stats) {
                const carriers: readonly SlotFamily[] = this.carriers(s.statId);
                const first: SlotFamily | undefined = carriers[0];
                if (first === undefined) {
                    continue;
                }
                // Every mod that could carry it is in one group: the item has a mod from that group.
                if (carriers.every((f: SlotFamily) => f.group === first.group)) {
                    pinned.add(first.group);
                }
                // Every mod that could carry it is on one side, and none of them could carry another include:
                // the pick takes an affix of its own on that side.
                const side: SlotModType = first.type;
                if (
                    (side === 'Prefix' || side === 'Suffix') &&
                    carriers.every((f: SlotFamily) => f.type === side) &&
                    !carriers.some((f: SlotFamily) => f.tradeIds.some((id: string) => others.has(id)))
                ) {
                    sides.add(side);
                }
            }
            for (const side of sides) {
                consumed[side] += 1;
            }
        }
        this.pinnedGroups = pinned;
        // A side is full only when it's full on every base the results can be.
        const full: Map<Side, FullSide> = new Map<Side, FullSide>();
        for (const side of SIDES) {
            const caps: readonly number[] = limits.map((l: AffixLimits) => limitOf(l, side));
            const first: number | undefined = caps[0];
            if (first !== undefined && caps.every((c: number) => consumed[side] >= c)) {
                full.set(side, {
                    state: caps.every((c: number) => c === 0) ? 'none' : 'filled',
                    limit: caps.every((c: number) => c === first) ? first : undefined,
                });
            }
        }
        this.fullSides = full;
    }

    /** The affix families that can carry a stat on a result. */
    public carriers(statId: string): readonly SlotFamily[] {
        return this.families.filter((f: SlotFamily) => f.tradeIds.includes(statId));
    }

    /**
     * Why no result can have this stat ('group' / 'side' / 'both'), or undefined when one can. A mod that
     * carries an included stat is never blocked: it may be the mod that meets the include.
     */
    public blocked(statId: string): Blocked | undefined {
        const carriers: readonly SlotFamily[] = this.carriers(statId);
        if (carriers.length === 0) {
            return undefined;
        }
        let byGroup: boolean = false;
        let bySide: boolean = false;
        const sides: Map<Side, FullSide> = new Map<Side, FullSide>();
        for (const f of carriers) {
            if (f.tradeIds.some((id: string) => this.includeStats.has(id))) {
                return undefined;
            }
            const full: FullSide | undefined = f.type === 'Prefix' || f.type === 'Suffix' ? this.fullSides.get(f.type) : undefined;
            if (this.pinnedGroups.has(f.group)) {
                byGroup = true;
            } else if ((f.type === 'Prefix' || f.type === 'Suffix') && full !== undefined) {
                bySide = true;
                sides.set(f.type, full);
            } else {
                return undefined;
            }
        }
        return { by: byGroup && bySide ? 'both' : byGroup ? 'group' : 'side', sides: sides };
    }
}

interface Analysis {
    readonly check: PlanCheck;
    /** The bases that fit the plan's defences. */
    readonly view: PlanSlotData | undefined;
    readonly room: RoomFacts | undefined;
    /** Affix stats the plan's base (or type) can roll, but no base with the plan's defences can. */
    readonly defenceOnly: ReadonlySet<string>;
}

/** "Ratcheting Ring has no prefixes", "an item has at most 3", "no Ring base has more than 6". */
function limitText(side: Side, count: number, view: PlanSlotData, plan: SlotPlan, limits: readonly AffixLimits[]): string {
    const caps: readonly number[] = limits.map((l: AffixLimits) => limitOf(l, side));
    const most: number = Math.max(0, ...caps);
    const words: string = `${count} ${SIDE_WORDS[side]} include${count === 1 ? '' : 's'}`;
    if (plan.base !== null) {
        return most === 0 ? `${words}: ${plan.base} has no ${SIDE_WORDS[side]}es` : `${words}: ${plan.base} has at most ${most}`;
    }
    if (caps.every((c: number) => c === most)) {
        return `${words}: an item has at most ${most}`;
    }
    return `${words}: no ${view.data.baseType} base has more than ${most}`;
}

function affixStats(view: PlanSlotData): ReadonlySet<string> {
    return new Set<string>(
        [...view.reachable('all').values()].filter((f: SlotFamily) => AFFIX_TYPES.includes(f.type)).flatMap((f: SlotFamily) => f.tradeIds),
    );
}

/** The plan's defence problems on these bases (before the defences narrow them). */
function defenceProblems(plan: SlotPlan, view: PlanSlotData, where: string): PlanIssue<PlanProblemCode>[] {
    const problems: PlanIssue<PlanProblemCode>[] = [];
    for (const [kind, range] of planDefences(plan)) {
        const name: string = DEFENCE_NAMES[kind];
        const ends: readonly (number | undefined)[] = [range.min, range.max];
        if (ends.some((v: number | undefined) => v !== undefined && (!Number.isInteger(v) || v < 0))) {
            problems.push({ code: 'bad-defence', pick: undefined, text: `${name}: the range takes whole numbers from 0` });
            continue;
        }
        if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
            problems.push({ code: 'bad-defence', pick: undefined, text: `${name}: its min ${range.min} is above its max ${range.max}` });
            continue;
        }
        const having: number = view.bases.filter((b: SlotBase) => b.defences[kind] !== undefined).length;
        if (range.max === 0 && having === view.bases.length) {
            const who: string = plan.base === null ? `Every ${where} base has` : `${plan.base} always has`;
            problems.push({ code: 'defence-always', pick: undefined, text: `${name} at most 0: ${who} ${name}` });
        } else if (range.min !== undefined && range.min > 0 && having === 0) {
            const who: string = plan.base === null ? `No ${where} base has` : `${plan.base} never has`;
            problems.push({ code: 'defence-never', pick: undefined, text: `${name} at least ${range.min}: ${who} ${name}` });
        }
    }
    return problems;
}

/** The defences at max 0 that a local stat adds to. */
function zeroedDefences(plan: SlotPlan, siteText: string): readonly DefenceKind[] {
    return localDefences(siteText).filter((k: DefenceKind) => plan.defences?.[k]?.max === 0);
}

function pickName(view: PlanSlotData, pick: ModPick, index: number): string {
    const first: PickStat | undefined = pick.stats[0];
    const what: string = first === undefined ? 'an empty mod' : `"${view.siteText(first.statId)}"`;
    return `${pick.rule === 'include' ? 'Include' : 'Exclude'} ${index + 1} (${what})`;
}

/**
 * Two includes on one stat (issue #71): both ranges are on the item's total (decision 10), so the search needs
 * their intersection. An empty one refuses the plan (pushed onto `problems`); otherwise a note says what the
 * search needs, since "hybrid ≥ 20 and pure ≥ 40" reads like 60 but is a total of 40.
 */
function sharedStatIssues(
    view: PlanSlotData,
    shared: ReadonlyMap<string, readonly { readonly pick: number; readonly stat: PickStat }[]>,
    problems: PlanIssue<PlanProblemCode>[],
): PlanIssue<PlanNoteCode>[] {
    const notes: PlanIssue<PlanNoteCode>[] = [];
    for (const [statId, uses] of shared) {
        const last: { readonly pick: number; readonly stat: PickStat } | undefined = uses.at(-1);
        if (uses.length < 2 || last === undefined) {
            continue;
        }
        const mins: readonly number[] = uses.flatMap((u) => (u.stat.min === undefined ? [] : [u.stat.min]));
        const maxes: readonly number[] = uses.flatMap((u) => (u.stat.max === undefined ? [] : [u.stat.max]));
        const min: number | undefined = mins.length === 0 ? undefined : Math.max(...mins);
        const max: number | undefined = maxes.length === 0 ? undefined : Math.min(...maxes);
        const names: string = uses.map((u) => `Include ${u.pick + 1}`).join(' and ');
        const stat: string = `"${view.siteText(statId)}"`;
        if (min !== undefined && max !== undefined && min > max) {
            problems.push({
                code: 'conflicting-ranges',
                pick: last.pick,
                text: `${names} both carry ${stat}: each range is on the item's total, and no total is at least ${min} and at most ${max}`,
            });
            continue;
        }
        const need: string =
            min !== undefined && max !== undefined
                ? `a total of ${min} to ${max}`
                : min !== undefined
                  ? `a total ≥ ${min}`
                  : max !== undefined
                    ? `a total ≤ ${max}`
                    : 'the stat on the item';
        notes.push({
            code: 'shared-stat',
            pick: last.pick,
            text: `${names} both carry ${stat}: each range is on the item's total, so the search needs ${need}, not each mod's own`,
        });
    }
    return notes;
}

function rangeProblem(pick: ModPick): string | undefined {
    for (const s of pick.stats) {
        const ends: readonly (number | undefined)[] = [s.min, s.max];
        if (pick.rule === 'exclude' && ends.some((v: number | undefined) => v !== undefined)) {
            return 'an exclude has no range';
        }
        if (ends.some((v: number | undefined) => v !== undefined && !Number.isFinite(v))) {
            return 'a range end is not a number';
        }
        if (s.min !== undefined && s.max !== undefined && s.min > s.max) {
            return `its min ${s.min} is above its max ${s.max}`;
        }
    }
    return undefined;
}

/** The totals' own problems (issue #26): a pseudo id, a sound range, each once, at most MAX_TOTALS. */
function totalProblems(plan: SlotPlan): PlanIssue<PlanProblemCode>[] {
    const totals: readonly PlanTotal[] = planTotals(plan);
    const problems: PlanIssue<PlanProblemCode>[] = [];
    const bad = (text: string): void => {
        problems.push({ code: 'bad-total', pick: undefined, text: text });
    };
    if (totals.length > MAX_TOTALS) {
        bad(`At most ${MAX_TOTALS} totals in one plan`);
    }
    const seen: Set<string> = new Set<string>();
    for (const t of totals) {
        if (!t.statId.startsWith('pseudo.')) {
            bad(`"${t.text}" isn't a pseudo total`);
        }
        if (seen.has(t.statId)) {
            bad(`"${t.text}" is in the totals twice`);
        }
        seen.add(t.statId);
        const ends: readonly (number | undefined)[] = [t.min, t.max];
        if (ends.some((v: number | undefined) => v !== undefined && !Number.isFinite(v))) {
            bad(`"${t.text}": a range end is not a number`);
        } else if (t.min !== undefined && t.max !== undefined && t.min > t.max) {
            bad(`"${t.text}": its min ${t.min} is above its max ${t.max}`);
        }
    }
    return problems;
}

/**
 * A generic weapon type's plan (#39): a category and totals, nothing that needs one item type's slot data. No
 * view or room, so pruning takes out only the totals' own weights.
 */
function genericAnalysis(
    plan: SlotPlan,
    problems: PlanIssue<PlanProblemCode>[],
    notes: readonly PlanIssue<PlanNoteCode>[],
    refuse: () => Analysis,
): Analysis {
    if (plan.base !== null || plan.picks.length > 0) {
        problems.push({
            code: 'generic-type',
            pick: undefined,
            text: `${plan.itemType ?? 'A generic type'} spans many item types: pick one item type to set a base or mods`,
        });
    }
    problems.push(...totalProblems(plan));
    if (problems.length > 0) {
        return refuse();
    }
    return {
        check: { ok: true, problems: [], notes: notes, plan: plan, influences: [] },
        view: undefined,
        room: undefined,
        defenceOnly: new Set<string>(),
    };
}

function analyse(plan: SlotPlan, slot: GearSlot, data: SlotData | undefined, gear: PlanGear | undefined): Analysis {
    const problems: PlanIssue<PlanProblemCode>[] = [];
    const notes: PlanIssue<PlanNoteCode>[] = [];
    const refuse = (): Analysis => ({
        check: { ok: false, problems: problems, notes: notes, plan: plan, influences: [] },
        view: undefined,
        room: undefined,
        defenceOnly: new Set<string>(),
    });
    if (plan.slot !== slot) {
        problems.push({ code: 'slot-mismatch', pick: undefined, text: `The plan is for ${plan.slot}, the run for ${slot}` });
    }
    const hands = handIssues(plan, gear);
    if (hands.problem !== undefined) {
        problems.push(hands.problem);
        return refuse();
    }
    if (hands.note !== undefined) {
        notes.push(hands.note);
    }
    if (hasNoMods(plan)) {
        return problems.length > 0
            ? refuse()
            : {
                  check: { ok: true, problems: [], notes: notes, plan: plan, influences: [] },
                  view: undefined,
                  room: undefined,
                  defenceOnly: new Set<string>(),
              };
    }
    if (plan.itemType !== null && !slotTakes(plan.slot, plan.itemType)) {
        problems.push({ code: 'wrong-slot', pick: undefined, text: `${plan.slot} can't hold a ${plan.itemType}` });
        return refuse();
    }
    if (planDefences(plan).length > 0 && !hasDefences(plan.itemType)) {
        problems.push({
            code: 'no-defences',
            pick: undefined,
            text: `${plan.itemType ?? 'No item type'}: no armour, evasion, energy shield or ward to set a range on`,
        });
        return refuse();
    }
    if (isGenericType(plan.itemType)) {
        return genericAnalysis(plan, problems, notes, refuse);
    }
    if (data === undefined) {
        problems.push({
            code: 'no-slot-data',
            pick: undefined,
            text: `No slot data for ${plan.itemType ?? plan.slot}: the plan can't be checked`,
        });
        return refuse();
    }
    if (plan.itemType !== data.baseType) {
        problems.push({
            code: 'slot-data-mismatch',
            pick: undefined,
            text: `The plan is for ${plan.itemType ?? 'no item type'}, the slot data for ${data.baseType}`,
        });
        return refuse();
    }
    const named: PlanSlotData = new PlanSlotData(data, plan.base);
    if (named.bases.length === 0) {
        problems.push({
            code: 'unknown-base',
            pick: undefined,
            text: `${plan.base ?? 'The base'} isn't a ${data.baseType} base in PoB ${data.pobVersion}`,
        });
        return refuse();
    }
    problems.push(...defenceProblems(plan, named, data.baseType), ...totalProblems(plan));
    if (problems.length > 0) {
        return refuse();
    }
    // From here on, only the bases that can have the plan's defences.
    const view: PlanSlotData = new PlanSlotData(data, plan.base, plan.defences);
    if (view.bases.length === 0) {
        problems.push({
            code: 'defences-no-base',
            pick: undefined,
            text: `No ${plan.base ?? `${data.baseType} base`} has these defences together`,
        });
        return refuse();
    }
    const where: string = plan.base ?? `any ${data.baseType}`;
    const includeIds: Set<string> = new Set<string>();
    const groups: Map<string, number> = new Map<string, number>();
    let prefixes: number = 0;
    let suffixes: number = 0;
    const eldritch: Record<'Exarch' | 'Eater', number> = { Exarch: 0, Eater: 0 };
    const influences: SlotInfluence[] = [];
    // Includes per stat: two on one stat are both on the item's total (decision 10), so their ranges intersect.
    const sharedStats: Map<string, { readonly pick: number; readonly stat: PickStat }[]> = new Map();
    plan.picks.forEach((pick: ModPick, i: number) => {
        const name: string = pickName(view, pick, i);
        if (pick.stats.length === 0) {
            problems.push({ code: 'empty-pick', pick: i, text: `${name} has no stats` });
            return;
        }
        const badRange: string | undefined = rangeProblem(pick);
        if (badRange !== undefined) {
            problems.push({ code: 'bad-range', pick: i, text: `${name}: ${badRange}` });
        }
        if (pick.rule !== 'include') {
            return;
        }
        for (const s of pick.stats) {
            includeIds.add(s.statId);
            sharedStats.set(s.statId, [...(sharedStats.get(s.statId) ?? []), { pick: i, stat: s }]);
        }
        if (pick.position === 'prefix') {
            prefixes += 1;
        } else if (pick.position === 'suffix') {
            suffixes += 1;
        }
        if (pick.group !== null) {
            // "One mod per group" holds among explicit affixes, and among implicits, never between the two: PoB
            // gives an implicit and an affix of the same family one group name (a chaos res implicit and suffix).
            const groupKey: string = `${pick.position === 'implicit' ? 'implicit' : 'affix'}:${pick.group}`;
            const other: number | undefined = groups.get(groupKey);
            if (other === undefined) {
                groups.set(groupKey, i);
            } else {
                problems.push({
                    code: 'same-group',
                    pick: i,
                    text: `${name} is in the same mod group as include ${other + 1}: an item can't have both`,
                });
            }
        }
        const source: PickSource | undefined = view.sourceOf(pick);
        const zeroed: readonly DefenceKind[] = pick.stats.flatMap((s: PickStat) => zeroedDefences(plan, view.siteText(s.statId)));
        const zero: DefenceKind | undefined = zeroed[0];
        if (zero !== undefined) {
            problems.push({
                code: 'include-and-defence',
                pick: i,
                text: `${name} adds ${DEFENCE_NAMES[zero]}, which the plan sets to at most 0`,
            });
            return;
        }
        if (source === undefined) {
            const pool: string = pick.influence === 'none' ? '' : ` with ${pick.influence} influence`;
            problems.push({ code: 'cannot-roll', pick: i, text: `${name} can't roll on ${where}${pool} as a ${pick.position}` });
            return;
        }
        if (source.kind === 'family' && (source.ref.family.type === 'Exarch' || source.ref.family.type === 'Eater')) {
            eldritch[source.ref.family.type] += 1;
        }
        if (pick.influence !== 'none' && !influences.includes(pick.influence)) {
            influences.push(pick.influence);
        }
    });
    // Each base's own limits (issue #37): the includes must fit on at least one base the plan allows.
    const limits: readonly AffixLimits[] = view.bases.map((b: SlotBase) => baseAffixes(b).limits);
    const holds = (l: AffixLimits): boolean => prefixes <= l.prefix && suffixes <= l.suffix;
    const fitting: readonly AffixLimits[] = limits.filter(holds);
    if (fitting.length === 0) {
        const prefixesFit: boolean = limits.some((l: AffixLimits) => prefixes <= l.prefix);
        const suffixesFit: boolean = limits.some((l: AffixLimits) => suffixes <= l.suffix);
        if (!prefixesFit) {
            problems.push({ code: 'too-many-prefixes', pick: undefined, text: limitText('Prefix', prefixes, view, plan, limits) });
        }
        if (!suffixesFit) {
            problems.push({ code: 'too-many-suffixes', pick: undefined, text: limitText('Suffix', suffixes, view, plan, limits) });
        }
        if (prefixesFit && suffixesFit) {
            problems.push({
                code: 'too-many-affixes',
                pick: undefined,
                text: `${prefixes} prefix and ${suffixes} suffix includes: no ${view.data.baseType} base has room for both`,
            });
        }
    }
    for (const type of ['Exarch', 'Eater'] as const) {
        if (eldritch[type] > 1) {
            problems.push({
                code: 'eldritch-limit',
                pick: undefined,
                text: `${eldritch[type]} ${type} implicit includes: an item has at most one`,
            });
        }
    }
    if (influences.length > MAX_INFLUENCES) {
        problems.push({
            code: 'too-many-influences',
            pick: undefined,
            text: `The includes need ${influences.length} influences (${influences.join(', ')}): an item has at most ${MAX_INFLUENCES}`,
        });
    }
    notes.push(...sharedStatIssues(view, sharedStats, problems));
    plan.picks.forEach((pick: ModPick, i: number) => {
        if (pick.rule !== 'exclude') {
            return;
        }
        // A hybrid exclude drops only items with that mod (#38), so it meets an include of one of its stats; it
        // clashes only with an include whose mod carries every one of its stats (a craft and its natural mod count
        // as one mod). A Not-group exclude clashes with any include of its stat.
        if (isHybridExclude(pick)) {
            if (plan.picks.some((p: ModPick) => p.rule === 'include' && carriesAll(p, pick))) {
                problems.push({
                    code: 'include-and-exclude',
                    pick: i,
                    text: `${pickName(view, pick, i)} excludes a mod the plan also includes`,
                });
            }
        } else if (pick.stats.some((s: PickStat) => includeIds.has(s.statId))) {
            problems.push({
                code: 'include-and-exclude',
                pick: i,
                text: `${pickName(view, pick, i)} excludes a stat the plan also includes`,
            });
        }
    });
    if (problems.length > 0) {
        return refuse();
    }
    const room: RoomFacts = new RoomFacts(view, plan, influences, fitting);
    // An exclude whose every stat no result can have anyway costs complexity for nothing.
    const picks: ModPick[] = [];
    plan.picks.forEach((pick: ModPick, i: number) => {
        if (
            pick.rule === 'exclude' &&
            pick.position !== 'implicit' &&
            pick.stats.every((s: PickStat) => room.blocked(s.statId) !== undefined)
        ) {
            notes.push({
                code: 'redundant-exclude',
                pick: i,
                text: `${pickName(view, pick, i)} is left out: the includes leave no room for it`,
            });
        } else {
            picks.push(pick);
            const hybrids: readonly string[] = pick.rule === 'exclude' && pick.position !== 'implicit' ? hybridsWith(room, pick) : [];
            if (hybrids.length > 0) {
                notes.push({ code: 'exclude-hybrids', pick: i, text: hybridsText(view, pick, i, hybrids) });
            }
        }
    });
    const rollable: ReadonlySet<string> = affixStats(view);
    return {
        check: { ok: true, problems: [], notes: notes, plan: { ...plan, picks: picks }, influences: influences },
        view: view,
        room: room,
        defenceOnly: new Set<string>([...affixStats(named)].filter((id: string) => !rollable.has(id))),
    };
}

/**
 * The hybrid mods a pure exclude's Not group keeps out too (#38: the site can't tell them apart), by their text
 * in slot data order, once each (a bench craft and its veiled copy read the same). None for a hybrid exclude.
 */
function hybridsWith(room: RoomFacts, pick: ModPick): readonly string[] {
    const stat: PickStat | undefined = pick.stats[0];
    if (stat === undefined || pick.stats.length !== 1) {
        return [];
    }
    const out: string[] = [];
    for (const f of room.carriers(stat.statId)) {
        if (f.tradeIds.length > 1 && !out.includes(f.text)) {
            out.push(f.text);
        }
    }
    return out;
}

/** "Exclude 1 ("+# to maximum Mana") also keeps out items with it from a hybrid mod: A, B and 1 more". */
function hybridsText(view: PlanSlotData, pick: ModPick, index: number, hybrids: readonly string[]): string {
    const shown: readonly string[] = hybrids.slice(0, 2);
    const more: number = hybrids.length - shown.length;
    const list: string = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(' and ');
    return `${pickName(view, pick, index)} also keeps out items with it from a hybrid mod: ${list}`;
}

/** The prune reasons that name a full side. */
type SideReason = Extract<PruneReason, 'prefixes-full' | 'suffixes-full' | 'affixes-full'>;

function sideReason(sides: ReadonlyMap<Side, FullSide>): SideReason {
    return sides.size > 1 ? 'affixes-full' : sides.has('Prefix') ? 'prefixes-full' : 'suffixes-full';
}

/** "The includes fill all 3 prefixes"; with bases of different limits, every base that can hold the includes. */
function sideText(reason: SideReason, sides: ReadonlyMap<Side, FullSide>): string {
    if (reason === 'affixes-full') {
        return 'The includes fill every prefix and suffix that could carry it';
    }
    const side: Side = reason === 'prefixes-full' ? 'Prefix' : 'Suffix';
    const limit: number | undefined = sides.get(side)?.limit;
    return limit === undefined
        ? `The includes fill every ${SIDE_WORDS[side]} on each base that can hold them`
        : `The includes fill all ${limit} ${SIDE_WORDS[side]}es`;
}

function pruned(w: WeightedStat, reason: PruneReason, text: string): PrunedWeight {
    return { statId: w.statId, weight: w.weight, reason: reason, text: text };
}

/** A weight list split by the plan: what stays in the weighted group, and what the plan took out and why. */
export interface PrunedWeights {
    readonly kept: readonly WeightedStat[];
    readonly pruned: readonly PrunedWeight[];
}

/** One plan analysed once against the slot data: its check, and the pruning of any weight list. */
export interface AnalysedPlan {
    readonly check: PlanCheck;
    /** The bases that fit the plan's defences; undefined for an empty or refused plan. */
    readonly view: PlanSlotData | undefined;
    /** Any weight list (PoB's, later ours) pruned by the plan. */
    prune(weights: readonly WeightedStat[]): PrunedWeights;
    /** The included stats with their ranges, as the plan holds them: the fixed part of the item. */
    fixedStats(): readonly PickStat[];
}

/** Analyses a plan once (PLAN.md, "v2a", "Checked before searching"): the check, then pruning from the same facts. */
export function analysePlan(plan: SlotPlan, slot: GearSlot, data: SlotData | undefined, gear?: PlanGear): AnalysedPlan {
    const analysis: Analysis = analyse(plan, slot, data, gear);
    return {
        check: analysis.check,
        view: analysis.view,
        prune: (weights: readonly WeightedStat[]): PrunedWeights => pruneWith(analysis, plan, weights),
        fixedStats: (): readonly PickStat[] =>
            analysis.check.ok
                ? analysis.check.plan.picks.filter((p: ModPick) => p.rule === 'include').flatMap((p: ModPick) => p.stats)
                : [],
    };
}

/** The feasibility rules alone (analysePlan's check). */
export function checkPlan(plan: SlotPlan, slot: GearSlot, data: SlotData | undefined, gear?: PlanGear): PlanCheck {
    return analyse(plan, slot, data, gear).check;
}

/**
 * Weights pruned to what can still exist and still matters (PLAN.md, "v2a"): the plan's Not group and included
 * stats (an include is a filter now), stats the chosen base can't roll, and stats with no room left (every mod
 * that carries it shares a group with an include or sits on a side that is full on every base the results can
 * be). Pseudo and implicit weights go only when included or excluded. Kept weights stay in their order. An empty
 * or refused plan prunes nothing; a generic weapon type's plan (#39) only its totals. `plan` is the plan as the user set it, so a redundant exclude still reads "excluded".
 */
function pruneWith(analysis: Analysis, plan: SlotPlan, weights: readonly WeightedStat[]): PrunedWeights {
    const { check, room, view, defenceOnly } = analysis;
    if (!check.ok) {
        return { kept: weights, pruned: [] };
    }
    // The Not group's excludes as the user set them: a redundant one still says "excluded". A hybrid exclude
    // prunes nothing by itself: other mods can still bring its stats (#38).
    const excluded: ReadonlySet<string> = new Set<string>(
        notGroupExcludes(plan.picks).flatMap((p: ModPick) => p.stats.map((s: PickStat) => s.statId)),
    );
    // An include's stat and a total's pseudo: either weight is a filter now.
    const included: ReadonlySet<string> = new Set<string>([
        ...plan.picks.filter((p: ModPick) => p.rule === 'include').flatMap((p: ModPick) => p.stats.map((s: PickStat) => s.statId)),
        ...planTotals(plan).map((t: PlanTotal) => t.statId),
    ]);
    const kept: WeightedStat[] = [];
    const out: PrunedWeight[] = [];
    for (const w of weights) {
        if (excluded.has(w.statId)) {
            out.push(pruned(w, 'excluded', 'Excluded in the slot plan'));
            continue;
        }
        if (included.has(w.statId)) {
            out.push(pruned(w, 'included', 'Included in the slot plan: a filter now'));
            continue;
        }
        // No slot data (an empty plan, a generic weapon type, #39): nothing more is known about what can roll.
        if (!w.statId.startsWith('explicit.') || room === undefined || view === undefined) {
            kept.push(w);
            continue;
        }
        if (defenceOnly.has(w.statId)) {
            const zero: DefenceKind | undefined = zeroedDefences(plan, view.siteText(w.statId))[0];
            const text: string =
                zero === undefined
                    ? "No base with the plan's defences can roll it"
                    : `${DEFENCE_NAMES[zero]} is at most 0 in the slot plan: no result has it`;
            out.push(pruned(w, 'defences', text));
            continue;
        }
        if (room.carriers(w.statId).length === 0) {
            if (plan.base !== null) {
                out.push(pruned(w, 'base-cannot-roll', `${plan.base} can't roll it`));
            } else {
                kept.push(w);
            }
            continue;
        }
        const blocked: Blocked | undefined = room.blocked(w.statId);
        if (blocked === undefined) {
            kept.push(w);
        } else if (blocked.by === 'group') {
            out.push(pruned(w, 'same-group', 'Every mod with it shares a mod group with an include'));
        } else if (blocked.by === 'side' && [...blocked.sides.values()].every((s: FullSide) => s.state === 'none')) {
            // No base the results can be has that side (a Ratcheting Ring's prefixes).
            const words: string = [...blocked.sides.keys()].map((s: Side) => `${SIDE_WORDS[s]}es`).join(' or ');
            const who: string = plan.base ?? `No ${view.data.baseType} base that can hold the includes`;
            out.push(pruned(w, 'base-cannot-roll', plan.base === null ? `${who} has ${words}` : `${who} has no ${words}`));
        } else if (blocked.by === 'side') {
            const reason: SideReason = sideReason(blocked.sides);
            out.push(pruned(w, reason, sideText(reason, blocked.sides)));
        } else {
            out.push(pruned(w, 'no-room', 'No room: every mod with it shares a group with an include or sits on a side the includes fill'));
        }
    }
    return { kept: kept, pruned: out };
}
