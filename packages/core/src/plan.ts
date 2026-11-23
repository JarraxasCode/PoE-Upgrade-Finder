// The slot plan (PLAN.md, "v2a: the slot plan" and "Phase 6"): what to search for on one slot, as plain data
// that knows nothing about the run around it. The base, implicits, up to 3 prefixes and 3 suffixes, each mod
// Include (results must have it) or Exclude (results never have it). This file checks a plan against PoB's
// slot data and prunes PoB's weights to what can still be on a result. The spec is built from it in
// slot-spec.ts.
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

import type {
    DefenceKind,
    GearSlot,
    SlotBase,
    SlotData,
    SlotFamily,
    SlotImplicit,
    SlotInfluence,
    SlotModStat,
    SlotModType,
} from '@poe-upgrade-finder/engine-client';
import { hasDefences, slotTakes } from './item-types.ts';
import type { PrunedWeight, PruneReason, WeightedStat } from './spec.ts';

// engine-client's SLOT_INFLUENCES: core takes only types from engine-client, whose index loads the process code.
const INFLUENCES: readonly SlotInfluence[] = ['none', 'shaper', 'elder', 'adjudicator', 'basilisk', 'crusader', 'eyrie'];

export type ModRule = 'include' | 'exclude';
export type ModPosition = 'implicit' | 'prefix' | 'suffix';

/** One trade stat of a picked mod. A hybrid mod has two. */
export interface PickStat {
    /** Trade stat id, e.g. explicit.stat_2250533757 (implicit.stat_… for implicits). */
    readonly statId: string;
    /**
     * Include only: the range on the item's total for the stat, as the mod reads ("reduced 20 to 32" is
     * 20 and 32). A stat the site words the opposite way is negated and swapped when sent. Either end optional.
     */
    readonly min?: number;
    readonly max?: number;
}

/**
 * A pseudo total the item must reach (issue #26), from any source: "+# total maximum Life ≥ 80" is met by life,
 * Strength or both. Its own pick, as on the site; a mod include always means the mod itself.
 */
export interface PlanTotal {
    /** The site's pseudo stat id, e.g. pseudo.pseudo_total_life. */
    readonly statId: string;
    /** The site's wording, e.g. "+# total maximum Life" (kept with the plan so the spec needs no stat list). */
    readonly text: string;
    readonly min?: number;
    readonly max?: number;
}

export interface ModPick {
    readonly position: ModPosition;
    /** PoB's mod group (the "one per group" rule); null for the base's own implicit. */
    readonly group: string | null;
    /** The pool the mod comes from: `none` for plain mods (and implicits), else the influence that adds it. */
    readonly influence: SlotInfluence;
    readonly rule: ModRule;
    readonly stats: readonly PickStat[];
}

export interface SlotPlan {
    readonly slot: GearSlot;
    /**
     * PoB's item type ("Boots", "Bow"): picks the slot data and sets the search's category (every base of the
     * type). Null: PoB's category, from the equipped item, as in v0.1. Weapon slots offer several (SLOT_ITEM_TYPES).
     */
    readonly itemType: string | null;
    /** PoB's base name ("Two-Toned Boots (Armour/Evasion)"); null: any base of the type. */
    readonly base: string | null;
    readonly picks: readonly ModPick[];
    /**
     * Ranges on the item's Armour, Evasion, Energy Shield and Ward as listed (issue #24), on item types that have
     * them. "Max Energy Shield 0, max Evasion 0" is a pure armour base. Missing or empty: no defence filter.
     */
    readonly defences?: PlanDefences;
    /** Pseudo totals the item must reach (issue #26). Missing or empty: none. */
    readonly totals?: readonly PlanTotal[];
}

/** At most this many totals in one plan (each costs 1 on the site's complexity). */
export const MAX_TOTALS: number = 10;

/** A whole-number range on one defence; either end optional. */
export interface DefenceRange {
    readonly min?: number;
    readonly max?: number;
}

export type PlanDefences = Readonly<Partial<Record<DefenceKind, DefenceRange>>>;

/** engine-client's DEFENCE_KINDS, in the order the editor and the query use. */
const DEFENCES: readonly DefenceKind[] = ['armour', 'evasion', 'energyShield', 'ward'];

export const DEFENCE_NAMES: Readonly<Record<DefenceKind, string>> = {
    armour: 'Armour',
    evasion: 'Evasion',
    energyShield: 'Energy Shield',
    ward: 'Ward',
};

/** The plan's defences that set an end, in order. */
export function planDefences(plan: SlotPlan): readonly (readonly [DefenceKind, DefenceRange])[] {
    const out: [DefenceKind, DefenceRange][] = [];
    for (const kind of DEFENCES) {
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
    for (const kind of DEFENCES) {
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

export function emptyPlan(slot: GearSlot): SlotPlan {
    return { slot: slot, itemType: null, base: null, picks: [] };
}

/** An empty plan searches exactly as v0.1 did (decision 8). */
export function isEmptyPlan(plan: SlotPlan): boolean {
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
    | 'no-slot-data'
    | 'slot-data-mismatch'
    | 'unknown-base'
    | 'empty-pick'
    | 'bad-range'
    | 'too-many-prefixes'
    | 'too-many-suffixes'
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
    | 'bad-total';

export type PlanNoteCode = 'redundant-exclude';

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

export const MAX_PREFIXES: number = 3;
export const MAX_SUFFIXES: number = 3;
/** An item has at most two influences (two conquerors, or Shaper/Elder with a conqueror, via the Awakener's Orb). */
export const MAX_INFLUENCES: number = 2;

const AFFIX_TYPES: readonly SlotModType[] = ['Prefix', 'Suffix'];
const POSITION_TYPES: Readonly<Record<ModPosition, readonly SlotModType[]>> = {
    prefix: ['Prefix'],
    suffix: ['Suffix'],
    implicit: ['Exarch', 'Eater', 'Corrupted'],
};

type Side = 'Prefix' | 'Suffix';

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

    /** With defences: only the bases that can have them (a max of 0 on Energy Shield leaves the bases without it). */
    public constructor(data: SlotData, baseName: string | null, defences?: PlanDefences) {
        this.data = data;
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
            for (const influence of INFLUENCES) {
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
        const types: readonly SlotModType[] = POSITION_TYPES[pick.position];
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
            const mod = this.data.mods[modId];
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

/** Which mods can still be on a result, given the plan's includes. */
class RoomFacts {
    private readonly families: readonly SlotFamily[];
    private readonly includeStats: ReadonlySet<string>;
    private readonly pinnedGroups: ReadonlySet<string>;
    private readonly fullSides: ReadonlySet<Side>;

    public constructor(view: PlanSlotData, plan: SlotPlan, influences: readonly SlotInfluence[]) {
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
        const full: Set<Side> = new Set<Side>();
        if (consumed.Prefix >= MAX_PREFIXES) {
            full.add('Prefix');
        }
        if (consumed.Suffix >= MAX_SUFFIXES) {
            full.add('Suffix');
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
    public blocked(statId: string): { readonly by: 'group' | 'side' | 'both'; readonly sides: ReadonlySet<Side> } | undefined {
        const carriers: readonly SlotFamily[] = this.carriers(statId);
        if (carriers.length === 0) {
            return undefined;
        }
        let byGroup: boolean = false;
        let bySide: boolean = false;
        const sides: Set<Side> = new Set<Side>();
        for (const f of carriers) {
            if (f.tradeIds.some((id: string) => this.includeStats.has(id))) {
                return undefined;
            }
            if (this.pinnedGroups.has(f.group)) {
                byGroup = true;
            } else if ((f.type === 'Prefix' || f.type === 'Suffix') && this.fullSides.has(f.type)) {
                bySide = true;
                sides.add(f.type);
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

function analyse(plan: SlotPlan, slot: GearSlot, data: SlotData | undefined): Analysis {
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
    if (isEmptyPlan(plan)) {
        return problems.length > 0
            ? refuse()
            : {
                  check: { ok: true, problems: [], notes: [], plan: plan, influences: [] },
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
    if (prefixes > MAX_PREFIXES) {
        problems.push({
            code: 'too-many-prefixes',
            pick: undefined,
            text: `${prefixes} prefix includes: an item has at most ${MAX_PREFIXES}`,
        });
    }
    if (suffixes > MAX_SUFFIXES) {
        problems.push({
            code: 'too-many-suffixes',
            pick: undefined,
            text: `${suffixes} suffix includes: an item has at most ${MAX_SUFFIXES}`,
        });
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
    plan.picks.forEach((pick: ModPick, i: number) => {
        if (pick.rule === 'exclude' && pick.stats.some((s: PickStat) => includeIds.has(s.statId))) {
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
    const room: RoomFacts = new RoomFacts(view, plan, influences);
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
        }
    });
    const fitting: ReadonlySet<string> = affixStats(view);
    return {
        check: { ok: true, problems: [], notes: notes, plan: { ...plan, picks: picks }, influences: influences },
        view: view,
        room: room,
        defenceOnly: new Set<string>([...affixStats(named)].filter((id: string) => !fitting.has(id))),
    };
}

/** The feasibility rules (PLAN.md, "v2a", "Checked before searching"), and the plan as it will be searched. */
export function checkPlan(plan: SlotPlan, slot: GearSlot, data: SlotData | undefined): PlanCheck {
    return analyse(plan, slot, data).check;
}

const SIDE_TEXT: Readonly<Record<'prefixes-full' | 'suffixes-full' | 'affixes-full', string>> = {
    'prefixes-full': 'The includes fill all 3 prefixes',
    'suffixes-full': 'The includes fill all 3 suffixes',
    'affixes-full': 'The includes fill every prefix and suffix that could carry it',
};

function pruned(w: WeightedStat, reason: PruneReason, text: string): PrunedWeight {
    return { statId: w.statId, weight: w.weight, reason: reason, text: text };
}

/**
 * PoB's weights pruned to what can still exist and still matters (PLAN.md, "v2a"): the plan's excluded and
 * included stats (an include is a filter now), stats the chosen base can't roll, and stats with no room left
 * (every mod that carries it shares a group with an include or sits on a side the includes fill). Pseudo and
 * implicit weights go only when included or excluded. Kept weights stay in their order. An empty or refused
 * plan prunes nothing.
 */
export function pruneWeights(
    weights: readonly WeightedStat[],
    plan: SlotPlan,
    slot: GearSlot,
    data: SlotData | undefined,
): { readonly kept: readonly WeightedStat[]; readonly pruned: readonly PrunedWeight[] } {
    const { check, room, view, defenceOnly } = analyse(plan, slot, data);
    if (!check.ok || room === undefined || view === undefined) {
        return { kept: weights, pruned: [] };
    }
    // The excludes as the user set them: a redundant one still says "excluded".
    const excluded: ReadonlySet<string> = new Set<string>(
        plan.picks.filter((p: ModPick) => p.rule === 'exclude').flatMap((p: ModPick) => p.stats.map((s: PickStat) => s.statId)),
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
        if (!w.statId.startsWith('explicit.')) {
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
        const blocked = room.blocked(w.statId);
        if (blocked === undefined) {
            kept.push(w);
        } else if (blocked.by === 'group') {
            out.push(pruned(w, 'same-group', 'Every mod with it shares a mod group with an include'));
        } else if (blocked.by === 'side') {
            const reason: 'prefixes-full' | 'suffixes-full' | 'affixes-full' =
                blocked.sides.size > 1 ? 'affixes-full' : blocked.sides.has('Prefix') ? 'prefixes-full' : 'suffixes-full';
            out.push(pruned(w, reason, SIDE_TEXT[reason]));
        } else {
            out.push(pruned(w, 'no-room', 'No room: every mod with it shares a group with an include or sits on a side the includes fill'));
        }
    }
    return { kept: kept, pruned: out };
}
