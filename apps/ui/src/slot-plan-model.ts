// The slot plan editor's model (PLAN.md, "v2a: the slot plan", decision 7): what each row can pick, why an
// option is greyed out, the range bounds, and the plan edits. Pure and DOM-free, so it's unit-tested.
// Main has the last word: core's checkPlan runs on every plan in the weight review and before a run; the
// rules here only steer the user away from picks it would refuse.

import { DEFENCE_KINDS, MAX_PLAN_TOTALS, SLOT_ITEM_TYPES } from '@poe-upgrade-finder/ipc';
import type {
    BaseOption,
    DefenceKind,
    DefenceRange,
    GearSlot,
    ImplicitOption,
    ModPick,
    ModPosition,
    ModRule,
    ModSource,
    PickStat,
    PlanDefences,
    PlanTotal,
    SlotEditorData,
    SlotInfluence,
    SlotModType,
    SlotPlan,
    StatOption,
    TotalOption,
} from '@poe-upgrade-finder/ipc';

/** Rows per side, as on an item. */
export const AFFIX_ROWS: number = 3;
/** Implicit rows: the base's own, one Exarch and one Eater, or a corrupted one; a spare row while under it. */
export const IMPLICIT_ROWS: number = 3;
/** An item has at most two influences (core's MAX_INFLUENCES). */
const MAX_INFLUENCES: number = 2;

/** What a row can pick: an affix, an eldritch or corrupted implicit, or the base's own implicit. */
export interface PlanOption {
    /** Position, group, influence and stat ids: what a pick stores, so equal keys search the same. */
    readonly key: string;
    readonly position: ModPosition;
    /** Every type with this key ("Exarch" and "Corrupted" share some implicits); "Base" for the base's own. */
    readonly types: readonly (SlotModType | 'Base')[];
    readonly group: string | null;
    readonly influence: SlotInfluence;
    /** Natural when any merged mod rolls naturally; else its other source (crafted, essence, veiled...). */
    readonly source: ModSource;
    /** The trade site's order for its stats (ModOption.rank); null when unknown. */
    readonly rank: number | null;
    readonly text: string;
    readonly stats: readonly StatOption[];
    /** Item level of the lowest tier; 0 for a base implicit. */
    readonly level: number;
    readonly tierCount: number;
    /** PoB names of the bases that roll it. */
    readonly bases: readonly string[];
}

export const INFLUENCE_LABELS: Readonly<Record<SlotInfluence, string>> = {
    none: '',
    shaper: 'Shaper',
    elder: 'Elder',
    adjudicator: 'Warlord',
    basilisk: 'Hunter',
    crusader: 'Crusader',
    eyrie: 'Redeemer',
};

function keyOf(position: ModPosition, group: string | null, influence: SlotInfluence, statIds: readonly string[]): string {
    return [position, group ?? '', influence, ...[...statIds].sort()].join('|');
}

export function pickKey(pick: ModPick): string {
    return keyOf(
        pick.position,
        pick.group,
        pick.influence,
        pick.stats.map((s: PickStat) => s.statId),
    );
}

function implicitKey(implicit: ImplicitOption): string {
    return keyOf(
        'implicit',
        null,
        'none',
        implicit.stats.map((s: StatOption) => s.statId),
    );
}

/** Every option of the data, one per key: affixes, eldritch and corrupted implicits, and the bases' own implicits. */
export function planOptions(data: SlotEditorData): readonly PlanOption[] {
    const out: Map<string, PlanOption> = new Map<string, PlanOption>();
    for (const m of data.mods) {
        const key: string = keyOf(
            m.position,
            m.group,
            m.influence,
            m.stats.map((s: StatOption) => s.statId),
        );
        const had: PlanOption | undefined = out.get(key);
        const level: number = m.tiers[0]?.level ?? 0;
        if (had === undefined) {
            out.set(key, {
                key: key,
                position: m.position,
                types: [m.type],
                group: m.group,
                influence: m.influence,
                source: m.source,
                rank: m.rank,
                text: m.text,
                stats: m.stats,
                level: level,
                tierCount: m.tiers.length,
                bases: m.bases,
            });
        } else {
            out.set(key, {
                ...had,
                // A bench craft or essence mod that searches the same as a natural one is that natural option.
                source: had.source === 'natural' || m.source === 'natural' ? 'natural' : had.source,
                rank: had.rank === null ? m.rank : m.rank === null ? had.rank : Math.min(had.rank, m.rank),
                types: had.types.includes(m.type) ? had.types : [...had.types, m.type],
                level: Math.min(had.level, level),
                tierCount: had.tierCount + m.tiers.length,
                stats: had.stats.map((s: StatOption) => widenStat(s, m.stats)),
                bases: [...new Set([...had.bases, ...m.bases])],
            });
        }
    }
    const bases: readonly BaseOption[] = data.base === null ? data.bases : data.bases.filter((b: BaseOption) => b.name === data.base);
    for (const b of bases) {
        for (const imp of b.implicits) {
            if (imp.stats.length === 0) {
                continue;
            }
            const key: string = implicitKey(imp);
            const had: PlanOption | undefined = out.get(key);
            if (had === undefined) {
                out.set(key, {
                    key: key,
                    position: 'implicit',
                    types: ['Base'],
                    group: null,
                    influence: 'none',
                    source: 'natural',
                    rank: null,
                    text: imp.lines.join(' / '),
                    stats: imp.stats,
                    level: 0,
                    tierCount: 0,
                    bases: [b.name],
                });
            } else {
                out.set(key, {
                    ...had,
                    stats: had.stats.map((s: StatOption) => widenStat(s, imp.stats)),
                    bases: had.bases.includes(b.name) ? had.bases : [...had.bases, b.name],
                });
            }
        }
    }
    return [...out.values()];
}

function widenStat(s: StatOption, others: readonly StatOption[]): StatOption {
    const o: StatOption | undefined = others.find((x: StatOption) => x.statId === s.statId);
    if (o?.roll === undefined || o.roll === null) {
        return s;
    }
    if (s.roll === null) {
        return { ...s, roll: o.roll };
    }
    return { ...s, roll: [Math.min(s.roll[0], o.roll[0]), Math.max(s.roll[1], o.roll[1])] };
}

/** The new pick for an option (no range yet). */
export function pickOf(option: PlanOption, rule: ModRule): ModPick {
    return {
        position: option.position,
        group: option.group,
        influence: option.influence,
        rule: rule,
        stats: option.stats.map((s: StatOption): PickStat => ({ statId: s.statId })),
    };
}

export function optionOf(options: readonly PlanOption[], pick: ModPick): PlanOption | undefined {
    const key: string = pickKey(pick);
    return options.find((o: PlanOption) => o.key === key);
}

/** A plan's rows: indices into its picks per position, in plan order. */
export function rowsOf(plan: SlotPlan): Readonly<Record<ModPosition, readonly number[]>> {
    const rows: Record<ModPosition, number[]> = { implicit: [], prefix: [], suffix: [] };
    plan.picks.forEach((p: ModPick, i: number) => {
        if (p.rule === 'include') {
            rows[p.position].push(i);
        }
    });
    return rows;
}

/**
 * The excludes, by index into the plan's picks (issue #29). They take no row: an item has 3 prefixes and 3
 * suffixes, so 3 includes fill a side, but any number of mods can be kept off it.
 */
export function excludeRows(plan: SlotPlan): readonly number[] {
    const out: number[] = [];
    plan.picks.forEach((p: ModPick, i: number) => {
        if (p.rule === 'exclude') {
            out.push(i);
        }
    });
    return out;
}

export function rowLimit(position: ModPosition): number {
    return position === 'implicit' ? IMPLICIT_ROWS : AFFIX_ROWS;
}

/**
 * Why an option can't go in a row with this rule, or undefined when it can. `replacing` is the pick the row
 * holds now (it doesn't count against itself).
 */
export function conflictOf(
    options: readonly PlanOption[],
    plan: SlotPlan,
    option: PlanOption,
    rule: ModRule,
    replacing: number | null,
): string | undefined {
    const others: { readonly pick: ModPick; readonly option: PlanOption | undefined }[] = plan.picks
        .filter((_p: ModPick, i: number) => i !== replacing)
        .map((p: ModPick) => ({ pick: p, option: optionOf(options, p) }));
    if (others.some((o) => pickKey(o.pick) === option.key)) {
        return 'Already in the plan';
    }
    const statIds: readonly string[] = option.stats.map((s: StatOption) => s.statId);
    const otherRule: ModRule = rule === 'include' ? 'exclude' : 'include';
    if (others.some((o) => o.pick.rule === otherRule && o.pick.stats.some((s: PickStat) => statIds.includes(s.statId)))) {
        return rule === 'include' ? 'The plan excludes this stat' : 'The plan includes this stat';
    }
    if (rule === 'exclude') {
        return undefined;
    }
    const includes = others.filter((o) => o.pick.rule === 'include');
    // One mod per group among affixes, and among implicits; an implicit and an affix may share a group (issue #30).
    const sameGroup = includes.find(
        (o) =>
            option.group !== null && o.pick.group === option.group && (o.pick.position === 'implicit') === (option.position === 'implicit'),
    );
    if (sameGroup !== undefined) {
        return `Same mod group as ${sameGroup.option?.text ?? 'another include'}: an item can't have both`;
    }
    for (const type of ['Exarch', 'Eater'] as const) {
        if (option.types.length === 1 && option.types[0] === type) {
            if (includes.some((o) => o.option !== undefined && o.option.types.length === 1 && o.option.types[0] === type)) {
                return `The plan already includes an ${type} implicit: an item has one`;
            }
        }
    }
    if (option.influence !== 'none') {
        const pinned: Set<SlotInfluence> = new Set<SlotInfluence>(
            includes.map((o) => o.pick.influence).filter((i: SlotInfluence) => i !== 'none'),
        );
        if (!pinned.has(option.influence) && pinned.size >= MAX_INFLUENCES) {
            const names: string = [...pinned].map((i: SlotInfluence) => INFLUENCE_LABELS[i]).join(' and ');
            return `The includes already need ${names}: an item has at most two influences`;
        }
    }
    return undefined;
}

/** Why a pick the plan holds can't be searched as it is (the base changed under it), or undefined. */
export function pickProblem(options: readonly PlanOption[], plan: SlotPlan, index: number, base: string | null): string | undefined {
    const pick: ModPick | undefined = plan.picks[index];
    if (pick === undefined) {
        return undefined;
    }
    const option: PlanOption | undefined = optionOf(options, pick);
    if (option === undefined) {
        return `Can't roll on ${base ?? 'this item type'}`;
    }
    return conflictOf(options, plan, option, pick.rule, index);
}

// Ranges (decision 10: on the item's total, summed over every mod that carries the stat) --------------------------

export interface StatBounds {
    /** The lowest single roll, as the mod reads. */
    readonly low: number;
    /** The most the stat can total on the item: the best mod per group, at most 3 per side (or the implicit rows). */
    readonly high: number;
}

/** Bounds for a picked stat, over the options read the same way (a "reduced" stat only counts "reduced" mods). */
export function statBounds(options: readonly PlanOption[], stat: StatOption): StatBounds | undefined {
    if (stat.roll === null) {
        return undefined;
    }
    const implicit: boolean = stat.statId.startsWith('implicit.');
    const bestPerGroup: Map<string, { readonly side: ModPosition; readonly value: number }> = new Map();
    let low: number = stat.roll[0];
    options.forEach((o: PlanOption, i: number) => {
        if ((o.position === 'implicit') !== implicit) {
            return;
        }
        const s: StatOption | undefined = o.stats.find((x: StatOption) => x.statId === stat.statId && x.negate === stat.negate);
        if (s?.roll === undefined || s.roll === null) {
            return;
        }
        low = Math.min(low, s.roll[0]);
        const group: string = o.group ?? `base:${i}`;
        const had = bestPerGroup.get(group);
        if (had === undefined || had.value < s.roll[1]) {
            bestPerGroup.set(group, { side: o.position, value: s.roll[1] });
        }
    });
    let high: number = 0;
    for (const side of ['implicit', 'prefix', 'suffix'] as const) {
        const values: number[] = [...bestPerGroup.values()]
            .filter((v) => v.side === side)
            .map((v) => v.value)
            .sort((a: number, b: number) => b - a);
        high += values.slice(0, rowLimit(side)).reduce((a: number, b: number) => a + b, 0);
    }
    return { low: low, high: Math.max(high, stat.roll[1]) };
}

/** A typed roll: empty is "no limit", a number is a value, anything else is refused. */
export function parseRoll(text: string): number | null | undefined {
    const t: string = text.trim();
    if (t === '') {
        return null;
    }
    const n: number = Number(t);
    return Number.isFinite(n) && Math.abs(n) <= 1e6 ? n : undefined;
}

// Search ----------------------------------------------------------------------------------------------------------

/**
 * How well a query matches a text: every word of the query must be in the text (case-insensitive), or for a
 * single word, its letters in order. Higher is better; undefined is no match.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
    const words: readonly string[] = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w !== '');
    if (words.length === 0) {
        return 0;
    }
    const hay: string = text.toLowerCase();
    let score: number = 0;
    let allFound: boolean = true;
    for (const w of words) {
        const at: number = hay.indexOf(w);
        if (at < 0) {
            allFound = false;
            break;
        }
        const wordStart: boolean = at === 0 || !/[a-z0-9]/.test(hay.charAt(at - 1));
        score += 10 + w.length + (wordStart ? 5 : 0) - Math.min(at, 50) / 50;
    }
    if (allFound) {
        return score;
    }
    if (words.length > 1) {
        return undefined;
    }
    // One word not found whole: its letters in order ("incres" finds "increased"), scored low.
    const word: string = words[0] ?? '';
    let from: number = 0;
    for (const ch of word) {
        const at: number = hay.indexOf(ch, from);
        if (at < 0) {
            return undefined;
        }
        from = at + 1;
    }
    return 1 + word.length / 10;
}

/** What the search looks in: the mod's text, its influence and type ("shaper", "exarch"). */
function searchText(option: PlanOption): string {
    return [option.text, INFLUENCE_LABELS[option.influence], ...option.types].join(' ');
}

export interface ListedOption {
    readonly option: PlanOption;
    /** Why it can't be picked with the row's rule; undefined when it can. */
    readonly conflict: string | undefined;
}

/** Natural mods first, then each other source as its own group at the bottom, as the trade site groups crafted and veiled. */
const SOURCE_ORDER: readonly ModSource[] = [
    'natural',
    'fossil',
    'essence',
    'crafted',
    'veiled',
    'beast',
    'necropolis',
    'delve',
    'incursion',
];

const INFLUENCE_ORDER: readonly SlotInfluence[] = ['none', 'shaper', 'elder', 'crusader', 'eyrie', 'basilisk', 'adjudicator'];

/**
 * The options for one row: its position, matching the query. Pickable ones first; with no query, plain mods
 * before influenced ones (grouped by influence), base implicits before eldritch; with one, best match first.
 */
export function listOptions(
    options: readonly PlanOption[],
    plan: SlotPlan,
    /** null: every position (the Exclude list). */
    position: ModPosition | null,
    rule: ModRule,
    query: string,
    replacing: number | null,
): readonly ListedOption[] {
    const scored: { readonly listed: ListedOption; readonly score: number }[] = [];
    for (const o of options) {
        if (position !== null && o.position !== position) {
            continue;
        }
        const score: number | undefined = fuzzyScore(query, searchText(o));
        if (score === undefined) {
            continue;
        }
        scored.push({ listed: { option: o, conflict: conflictOf(options, plan, o, rule, replacing) }, score: score });
    }
    const typeRank = (o: PlanOption): number => (o.types.includes('Base') ? 0 : o.types.includes('Corrupted') ? 2 : 1);
    // The trade site's order: its stat list is most used first. Unknown ranks go after known ones.
    const siteRank = (o: PlanOption): number => o.rank ?? Number.MAX_SAFE_INTEGER;
    return scored
        .sort(
            (a, b) =>
                Number(a.listed.conflict !== undefined) - Number(b.listed.conflict !== undefined) ||
                (query.trim() === '' ? 0 : b.score - a.score) ||
                SOURCE_ORDER.indexOf(a.listed.option.source) - SOURCE_ORDER.indexOf(b.listed.option.source) ||
                INFLUENCE_ORDER.indexOf(a.listed.option.influence) - INFLUENCE_ORDER.indexOf(b.listed.option.influence) ||
                typeRank(a.listed.option) - typeRank(b.listed.option) ||
                siteRank(a.listed.option) - siteRank(b.listed.option) ||
                a.listed.option.text.localeCompare(b.listed.option.text),
        )
        .map((s) => s.listed);
}

function rangeText(roll: readonly [number, number]): string {
    return roll[0] === roll[1] ? String(roll[0]) : `(${roll[0]}–${roll[1]})`;
}

/**
 * The option as it reads on an item, with its rolls: "(10–35)% increased Movement Speed". A line whose stat
 * isn't found, or that has more than one number ("Adds # to #"), keeps its #.
 */
export function optionLabel(option: PlanOption): string {
    if (option.types.includes('Base')) {
        return option.text;
    }
    return option.text
        .split(' / ')
        .map((segment: string) => {
            const s: StatOption | undefined = option.stats.find((x: StatOption) => x.text === segment);
            if (s === undefined || s.roll === null || segment.split('#').length !== 2) {
                return segment;
            }
            return segment.replace('#', rangeText(s.roll));
        })
        .join(' / ');
}

/** "Exarch", "Exarch or Corrupted", "Base implicit", "Shaper prefix". */
/** How each source reads on its tag; natural mods have none. */
export const SOURCE_LABELS: Readonly<Record<ModSource, string>> = {
    natural: '',
    fossil: 'Fossil',
    crafted: 'Crafted',
    essence: 'Essence',
    veiled: 'Veiled',
    beast: 'Beastcraft',
    necropolis: 'Necropolis',
    delve: 'Delve',
    incursion: 'Incursion',
};

export function kindLabel(option: PlanOption): string {
    if (option.position !== 'implicit') {
        const side: string = option.position === 'prefix' ? 'prefix' : 'suffix';
        if (option.source !== 'natural') {
            return `${SOURCE_LABELS[option.source]} ${side}`;
        }
        return option.influence === 'none' ? side : `${INFLUENCE_LABELS[option.influence]} ${side}`;
    }
    return option.types.map((t) => (t === 'Base' ? 'Base implicit' : t)).join(' or ');
}

// Edits -------------------------------------------------------------------------------------------------------------

/** The item type the editor shows: the plan's, else what's equipped (when the slot holds it), else the slot's first. */
export function editorItemType(slot: GearSlot, plan: SlotPlan, equippedType: string | null): string {
    const types: readonly string[] = SLOT_ITEM_TYPES[slot];
    if (plan.itemType !== null) {
        return plan.itemType;
    }
    if (equippedType !== null && types.includes(equippedType)) {
        return equippedType;
    }
    return types[0] ?? slot;
}

/** A plan with a base, mods or defences names its item type; one with none and the equipped type goes back to empty. */
function settle(plan: SlotPlan, itemType: string, equippedType: string | null): SlotPlan {
    const bare: boolean = plan.base === null && plan.picks.length === 0 && setDefences(plan).length === 0 && totalsOf(plan).length === 0;
    if (bare && (itemType === equippedType || equippedType === null)) {
        return { ...plan, itemType: null };
    }
    return { ...plan, itemType: itemType };
}

/** Changes the item type: the base, mods and defences are for the old one, so they go. */
export function withItemType(plan: SlotPlan, itemType: string, equippedType: string | null): SlotPlan {
    if (plan.itemType === itemType) {
        return plan;
    }
    // The totals aren't tied to a type: they stay.
    const totals: readonly PlanTotal[] = totalsOf(plan);
    return settle(
        { slot: plan.slot, itemType: itemType, base: null, picks: [], ...(totals.length === 0 ? {} : { totals: totals }) },
        itemType,
        equippedType,
    );
}

/** Changes the base; picks stay (a pick the new base can't roll shows its problem). */
export function withBase(plan: SlotPlan, base: string | null, itemType: string, equippedType: string | null): SlotPlan {
    return settle({ ...plan, base: base }, itemType, equippedType);
}

/** Puts a pick in a row: replaces the pick at `index`, or adds it. */
export function withPick(plan: SlotPlan, index: number | null, pick: ModPick, itemType: string): SlotPlan {
    const picks: ModPick[] = [...plan.picks];
    if (index === null || index >= picks.length) {
        picks.push(pick);
    } else {
        picks[index] = pick;
    }
    return { ...plan, itemType: itemType, picks: picks };
}

export function withoutPick(plan: SlotPlan, index: number, itemType: string, equippedType: string | null): SlotPlan {
    return settle({ ...plan, picks: plan.picks.filter((_p: ModPick, i: number) => i !== index) }, itemType, equippedType);
}

/** Include or Exclude; an exclude has no range. */
export function withRule(plan: SlotPlan, index: number, rule: ModRule): SlotPlan {
    return {
        ...plan,
        picks: plan.picks.map((p: ModPick, i: number) =>
            i !== index
                ? p
                : { ...p, rule: rule, stats: rule === 'exclude' ? p.stats.map((s: PickStat) => ({ statId: s.statId })) : p.stats },
        ),
    };
}

/** Sets one end of a stat's range (null clears it). */
export function withRange(plan: SlotPlan, index: number, statId: string, end: 'min' | 'max', value: number | null): SlotPlan {
    return {
        ...plan,
        picks: plan.picks.map((p: ModPick, i: number) => {
            if (i !== index) {
                return p;
            }
            return {
                ...p,
                stats: p.stats.map((s: PickStat): PickStat => {
                    if (s.statId !== statId) {
                        return s;
                    }
                    const min: number | null = end === 'min' ? value : (s.min ?? null);
                    const max: number | null = end === 'max' ? value : (s.max ?? null);
                    return {
                        statId: s.statId,
                        ...(min === null ? {} : { min: min }),
                        ...(max === null ? {} : { max: max }),
                    };
                }),
            };
        }),
    };
}

/** Clear mods: keeps the type, base and defences. */
export function withoutPicks(plan: SlotPlan, itemType: string, equippedType: string | null): SlotPlan {
    return settle({ ...plan, picks: [] }, itemType, equippedType);
}

// Defences (issue #24) ------------------------------------------------------------------------------------------------

export const DEFENCE_LABELS: Readonly<Record<DefenceKind, string>> = {
    armour: 'Armour',
    evasion: 'Evasion',
    energyShield: 'Energy Shield',
    ward: 'Ward',
};

/** The plan's defences that set an end, in order. */
export function setDefences(plan: SlotPlan): readonly (readonly [DefenceKind, DefenceRange])[] {
    const out: [DefenceKind, DefenceRange][] = [];
    for (const kind of DEFENCE_KINDS) {
        const range: DefenceRange | undefined = plan.defences?.[kind];
        if (range !== undefined && (range.min !== undefined || range.max !== undefined)) {
            out.push([kind, range]);
        }
    }
    return out;
}

/** The defences any base here has, in order: the Defences row shows these (none on a quiver, ring or weapon). */
export function defenceKindsOf(data: SlotEditorData): readonly DefenceKind[] {
    return DEFENCE_KINDS.filter((k: DefenceKind) => data.bases.some((b: BaseOption) => b.defences[k] !== undefined));
}

/** A typed defence value: empty is "no limit", a whole number from 0 is a value, anything else is refused. */
export function parseDefence(text: string): number | null | undefined {
    const t: string = text.trim();
    if (t === '') {
        return null;
    }
    const n: number = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : undefined;
}

/** Sets one end of a defence's range (null clears it); a defence with no ends left goes. */
export function withDefence(
    plan: SlotPlan,
    kind: DefenceKind,
    end: 'min' | 'max',
    value: number | null,
    itemType: string,
    equippedType: string | null,
): SlotPlan {
    const had: DefenceRange = plan.defences?.[kind] ?? {};
    const min: number | null = end === 'min' ? value : (had.min ?? null);
    const max: number | null = end === 'max' ? value : (had.max ?? null);
    const next: Partial<Record<DefenceKind, DefenceRange>> = { ...plan.defences };
    if (min === null && max === null) {
        delete next[kind];
    } else {
        next[kind] = { ...(min === null ? {} : { min: min }), ...(max === null ? {} : { max: max }) };
    }
    const { defences: _old, ...rest } = plan;
    const defences: PlanDefences = next;
    // Setting a defence names the item type, like a base or a mod does.
    const named: SlotPlan = { ...rest, itemType: itemType };
    return settle(Object.keys(defences).length === 0 ? named : { ...named, defences: defences }, itemType, equippedType);
}

/** "Energy Shield ≤ 0, Armour ≥ 300" for the plan's summary line; undefined with none. */
export function defencesSummary(plan: SlotPlan): string | undefined {
    const parts: readonly string[] = defenceSummaryParts(plan);
    return parts.length === 0 ? undefined : parts.join(', ');
}

/** Each set defence in short ("Armour ≥ 700", "Evasion ≤ 0"), in the editor's order. */
export function defenceSummaryParts(plan: SlotPlan): readonly string[] {
    return setDefences(plan).map(([kind, r]: readonly [DefenceKind, DefenceRange]) => {
        const name: string = DEFENCE_LABELS[kind];
        if (r.min !== undefined && r.max !== undefined) {
            return r.min === r.max ? `${name} ${r.min}` : `${name} ${r.min} to ${r.max}`;
        }
        return r.min !== undefined ? `${name} ≥ ${r.min}` : `${name} ≤ ${r.max ?? ''}`;
    });
}

// Totals (issue #26) ----------------------------------------------------------------------------------------------

/** The plan's totals (none when missing). */
export function totalsOf(plan: SlotPlan): readonly PlanTotal[] {
    return plan.totals ?? [];
}

function withTotals(plan: SlotPlan, totals: readonly PlanTotal[], itemType: string, equippedType: string | null): SlotPlan {
    const { totals: _old, ...rest } = plan;
    // A total names the item type, like a base or a mod does.
    const named: SlotPlan = { ...rest, itemType: itemType };
    return settle(totals.length === 0 ? named : { ...named, totals: totals }, itemType, equippedType);
}

/** Adds a total (once; at most MAX_PLAN_TOTALS), with no range yet. */
export function withTotal(plan: SlotPlan, option: TotalOption, itemType: string, equippedType: string | null): SlotPlan {
    const totals: readonly PlanTotal[] = totalsOf(plan);
    if (totals.length >= MAX_PLAN_TOTALS || totals.some((t: PlanTotal) => t.statId === option.id)) {
        return plan;
    }
    return withTotals(plan, [...totals, { statId: option.id, text: option.text }], itemType, equippedType);
}

export function withoutTotal(plan: SlotPlan, statId: string, itemType: string, equippedType: string | null): SlotPlan {
    return withTotals(
        plan,
        totalsOf(plan).filter((t: PlanTotal) => t.statId !== statId),
        itemType,
        equippedType,
    );
}

/** Sets one end of a total's range; null clears it. */
export function withTotalRange(
    plan: SlotPlan,
    statId: string,
    end: 'min' | 'max',
    value: number | null,
    itemType: string,
    equippedType: string | null,
): SlotPlan {
    const totals: PlanTotal[] = totalsOf(plan).map((t: PlanTotal): PlanTotal => {
        if (t.statId !== statId) {
            return t;
        }
        const min: number | null = end === 'min' ? value : (t.min ?? null);
        const max: number | null = end === 'max' ? value : (t.max ?? null);
        return { statId: t.statId, text: t.text, ...(min === null ? {} : { min: min }), ...(max === null ? {} : { max: max }) };
    });
    return withTotals(plan, totals, itemType, equippedType);
}

/** The totals the picker lists for a query: every one not in the plan yet, best match first (all of them when empty). */
export function listTotals(options: readonly TotalOption[], plan: SlotPlan, query: string): readonly TotalOption[] {
    const taken: ReadonlySet<string> = new Set<string>(totalsOf(plan).map((t: PlanTotal) => t.statId));
    const scored: { readonly option: TotalOption; readonly score: number; readonly order: number }[] = [];
    options.forEach((o: TotalOption, order: number) => {
        if (taken.has(o.id)) {
            return;
        }
        const score: number | undefined = query.trim() === '' ? 0 : fuzzyScore(query, `${o.text} pseudo total`);
        if (score !== undefined) {
            scored.push({ option: o, score: score, order: order });
        }
    });
    // The measured totals (they say what counts) come first among the matches: they're the common ones.
    const measured = (o: TotalOption): number => (o.counts === null ? 1 : 0);
    return scored.sort((a, b) => measured(a.option) - measured(b.option) || b.score - a.score || a.order - b.order).map((x) => x.option);
}
