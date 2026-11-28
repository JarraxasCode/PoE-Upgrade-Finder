// The slot plan editor on the Search view (PLAN.md, "v2a: the slot plan", decision 7): one component bound to
// one plan, laid out like an item: item type and base, implicit rows, 3 prefix rows, 3 suffix rows. Each row is
// a mod that can roll there, Include or Exclude, with a min/max range on an include. Every edit is saved at
// once; the weight review beside it reloads and shows what the plan takes out.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import type { BaseOption, SlotEditorData, StatOption, TotalOption } from '@poe-upgrade-finder/ipc';
import {
    DEFENCE_LABELS,
    defenceKindsOf,
    defenceSummaryParts,
    socketSummaryParts,
    editorItemType,
    kindLabel,
    listOptions,
    optionLabel,
    optionOf,
    parseDefence,
    parseRoll,
    pickOf,
    pickProblem,
    planOptions,
    emptyRows,
    planAffixes,
    rowLimit,
    excludeRows,
    rowsOf,
    statBounds,
    withBase,
    listTotals,
    totalsOf,
    withDefence,
    withoutTotal,
    withTotal,
    withTotalRange,
    withItemType,
    withoutPick,
    withoutPicks,
    withPick,
    withRange,
} from '../slot-plan-model.ts';
import type { ListedOption, PlanOption, StatBounds } from '../slot-plan-model.ts';
import { editorData, editorDataKey, isEmptySlotPlan, loadEditorData, planFor, setSlotPlan } from '../state/plan.ts';
import { retrySave, selectedBuildId, unsaved } from '../state/builds.ts';
import { weightPreview } from '../state/weights.ts';
import { Info } from './item-card.tsx';
import { SocketFilters } from './socket-filters.tsx';
import { InfluenceIcon, MARK_OF_INFLUENCE } from './influence-icon.tsx';
import type { MarkKind } from './influence-icon.tsx';
import { anyOfType, isGenericType, MAX_TOTALS, slotItemTypes } from '@poe-upgrade-finder/vocab';
import type {
    BaseAffixes,
    DefenceKind,
    DefenceRange,
    GearSlot,
    ModPick,
    ModPosition,
    ModRule,
    PickStat,
    PlanTotal,
    SlotPlan,
} from '@poe-upgrade-finder/vocab';

/** The clear/remove mark: two strokes, drawn so it stays crisp at any size. */
function ClearIcon(): JSX.Element {
    return (
        <svg class="clear-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}

/** What every row needs: the data, the plan and how to change it. */
interface Ctx {
    readonly data: SlotEditorData;
    readonly options: readonly PlanOption[];
    readonly plan: SlotPlan;
    /** What the plan's base allows on its affixes: the rows and the bounds (issue #37). */
    readonly affixes: BaseAffixes;
    readonly itemType: string;
    readonly equippedType: string | null;
}

const POSITION_WORDS: Readonly<Record<ModPosition, { readonly title: string; readonly one: string }>> = {
    implicit: { title: 'Implicits', one: 'implicit' },
    prefix: { title: 'Prefixes', one: 'prefix' },
    suffix: { title: 'Suffixes', one: 'suffix' },
};

/** The mark and colour class for an option: its influence, else its eldritch source (Exarch, Eater). */
function markOf(o: PlanOption): MarkKind | undefined {
    if (o.influence !== 'none') {
        return MARK_OF_INFLUENCE[o.influence];
    }
    if (o.types.includes('Exarch')) {
        return 'exarch';
    }
    return o.types.includes('Eater') ? 'eater' : undefined;
}

/** "Redeemer prefix" with its mark, in the influence's colour; plain prefixes and suffixes tinted by side. */
function InfluenceTag(props: { readonly option: PlanOption }): JSX.Element | null {
    const o: PlanOption = props.option;
    const mark: MarkKind | undefined = markOf(o);
    const tone: string =
        o.source !== 'natural'
            ? `src-${o.source}`
            : mark !== undefined
              ? `mark-${mark}`
              : o.types.includes('Corrupted')
                ? 'kind-corrupted'
                : `kind-${o.position}`;
    return (
        <span class={`mod-kind ${tone}`}>
            {mark !== undefined && <InfluenceIcon kind={mark} />}
            {kindLabel(o)}
        </span>
    );
}

/** A row's searchable list: type to narrow, arrows and Enter to pick, Escape to close. */
function ModPicker(props: {
    readonly ctx: Ctx;
    /** null: every position (the Exclude list). */
    readonly position: ModPosition | null;
    readonly rule: ModRule;
    readonly replacing: number | null;
    readonly autoFocus: boolean;
    readonly onPick: (option: PlanOption) => void;
    readonly onClose: () => void;
}): JSX.Element {
    const { ctx } = props;
    const [query, setQuery] = useState<string>('');
    const [open, setOpen] = useState<boolean>(props.autoFocus);
    const [active, setActive] = useState<number>(0);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);
    useEffect(() => {
        if (props.autoFocus) {
            input.current?.focus();
        }
    }, []);
    const listed: readonly ListedOption[] = open
        ? listOptions(ctx.options, ctx.plan, props.position, props.rule, query, props.replacing)
        : [];
    const shown: readonly ListedOption[] = listed;
    const id: string = `picker-${props.position ?? 'exclude'}-${props.replacing ?? 'new'}`;
    useEffect(() => {
        list.current?.querySelector('.mod-option.active')?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);
    const pick = (l: ListedOption | undefined): void => {
        if (l === undefined || l.conflict !== undefined) {
            return;
        }
        props.onPick(l.option);
        setQuery('');
        setOpen(false);
    };
    const move = (step: number): void => {
        if (shown.length === 0) {
            return;
        }
        let i: number = active;
        for (let n = 0; n < shown.length; n += 1) {
            i = (i + step + shown.length) % shown.length;
            if (shown[i]?.conflict === undefined) {
                break;
            }
        }
        setActive(i);
    };
    return (
        <div class="mod-picker">
            <input
                ref={input}
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls={`${id}-list`}
                aria-activedescendant={open && shown[active] !== undefined ? `${id}-${active}` : undefined}
                aria-autocomplete="list"
                aria-label={props.position === null ? 'Search mods to exclude' : `Search ${POSITION_WORDS[props.position].one} mods`}
                placeholder={
                    props.position === null
                        ? 'Exclude a mod: search any prefix, suffix or implicit'
                        : `Any ${POSITION_WORDS[props.position].one}: search to include one`
                }
                value={query}
                onFocus={() => {
                    setOpen(true);
                }}
                onBlur={() => {
                    setOpen(false);
                    props.onClose();
                }}
                onInput={(e: TargetedEvent<HTMLInputElement>) => {
                    setQuery(e.currentTarget.value);
                    setActive(0);
                    setOpen(true);
                }}
                onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        if (!open) {
                            setOpen(true);
                        } else {
                            move(1);
                        }
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        move(-1);
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        pick(shown[active]);
                    } else if (e.key === 'Escape') {
                        setOpen(false);
                        input.current?.blur();
                    }
                }}
            />
            {open && (
                <ul class="mod-options" id={`${id}-list`} role="listbox" ref={list}>
                    {shown.length === 0 && <li class="mod-option none muted">Nothing matches “{query}”.</li>}
                    {shown.map((l: ListedOption, i: number) => {
                        return (
                            <li
                                key={l.option.key}
                                id={`${id}-${i}`}
                                role="option"
                                aria-selected={i === active}
                                aria-disabled={l.conflict !== undefined}
                                class={`mod-option${i === active ? ' active' : ''}${l.conflict !== undefined ? ' blocked' : ''}`}
                                onMouseDown={(e: MouseEvent) => {
                                    e.preventDefault();
                                }}
                                onMouseEnter={() => {
                                    setActive(i);
                                }}
                                onClick={() => {
                                    pick(l);
                                }}
                            >
                                <span class="mod-text">{optionLabel(l.option)}</span>
                                <span class="mod-meta">
                                    <InfluenceTag option={l.option} />
                                    {l.option.level > 1 && <span class="muted">ilvl {l.option.level}+</span>}
                                </span>
                                {l.conflict !== undefined && <span class="mod-why">{l.conflict}</span>}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

/** "20" or "20.5": a bound as typed back into the box. */
function rollText(n: number | undefined): string {
    return n === undefined ? '' : String(n);
}

/** One stat's min/max on an include, on the item's total (decision 10). */
function StatRange(props: {
    readonly ctx: Ctx;
    readonly index: number;
    readonly stat: StatOption;
    readonly picked: PickStat;
    /** On the mod's own line (a one-stat include): just the boxes, the mod's text is the label. */
    readonly inline?: boolean;
}): JSX.Element {
    const { ctx, index, stat, picked } = props;
    const bounds: StatBounds | undefined = statBounds(ctx.options, stat, ctx.affixes);
    const [minText, setMinText] = useState<string>(rollText(picked.min));
    const [maxText, setMaxText] = useState<string>(rollText(picked.max));
    useEffect(() => {
        setMinText(rollText(picked.min));
        setMaxText(rollText(picked.max));
    }, [picked.min, picked.max]);
    const min: number | null | undefined = parseRoll(minText);
    const max: number | null | undefined = parseRoll(maxText);
    const commit = (end: 'min' | 'max', value: number | null | undefined): void => {
        if (value === undefined || value === (picked[end] ?? null)) {
            return;
        }
        setSlotPlan(withRange(ctx.plan, index, stat.statId, end, value));
    };
    let problem: string | undefined;
    if (min === undefined || max === undefined) {
        problem = 'Type a number, or leave it empty for no limit.';
    } else if (min !== null && max !== null && min > max) {
        problem = 'The min is above the max.';
    } else if (bounds !== undefined && min !== null && min > bounds.high) {
        problem = `Above the most it can total here (${bounds.high}): nothing will match.`;
    } else if (bounds !== undefined && max !== null && max < bounds.low) {
        problem = `Below the lowest roll (${bounds.low}).`;
    }
    const label: string = stat.text;
    const box = (end: 'min' | 'max', text: string, set: (t: string) => void, value: number | null | undefined): JSX.Element => (
        <input
            class="num roll-input"
            inputMode="decimal"
            aria-label={`${end === 'min' ? 'Min' : 'Max'} for ${label}`}
            aria-invalid={value === undefined}
            placeholder={bounds === undefined ? 'any' : String(end === 'min' ? bounds.low : bounds.high)}
            title={bounds === undefined ? undefined : `The item's total, from every line that carries it: ${bounds.low} to ${bounds.high}`}
            value={text}
            onInput={(e: TargetedEvent<HTMLInputElement>) => {
                set(e.currentTarget.value);
            }}
            onChange={() => {
                commit(end, value);
            }}
            onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                    commit(end, value);
                }
            }}
        />
    );
    if (props.inline === true) {
        return (
            <span class="stat-range inline">
                {box('min', minText, setMinText, min)}
                <span class="muted small">to</span>
                {box('max', maxText, setMaxText, max)}
                {problem !== undefined && <span class="hint fail stat-range-problem">{problem}</span>}
            </span>
        );
    }
    return (
        <div class="stat-range">
            <span class="stat-range-label">{label}</span>
            {box('min', minText, setMinText, min)}
            <span class="muted small">to</span>
            {box('max', maxText, setMaxText, max)}
            {problem !== undefined && <span class="hint fail stat-range-problem">{problem}</span>}
        </div>
    );
}

/** A row with a pick in it. */
function FilledRow(props: { readonly ctx: Ctx; readonly index: number; readonly pick: ModPick }): JSX.Element {
    const { ctx, index, pick } = props;
    const [changing, setChanging] = useState<boolean>(false);
    const option: PlanOption | undefined = optionOf(ctx.options, pick);
    const problem: string | undefined = pickProblem(ctx.options, ctx.plan, index, ctx.data.base);
    // The mod as the site words it ("#% increased Life Regeneration rate"): its rolls are the boxes' placeholders.
    const text: string = option === undefined ? pick.stats.map((s: PickStat) => s.statId).join(' / ') : option.text;
    const ranged: readonly StatOption[] =
        pick.rule === 'include' && option !== undefined ? option.stats.filter((s: StatOption) => s.roll !== null) : [];
    const pickedOf = (s: StatOption): PickStat => pick.stats.find((p: PickStat) => p.statId === s.statId) ?? { statId: s.statId };
    // One stat with a range: its boxes sit on the mod's own line. A hybrid keeps a line per stat.
    const single: StatOption | undefined = ranged.length === 1 ? ranged[0] : undefined;
    return (
        <li class={`plan-row filled rule-${pick.rule}${problem !== undefined ? ' has-problem' : ''}`}>
            <div class={`plan-row-main${single !== undefined && !changing ? ' inline' : ''}`}>
                {changing ? (
                    <ModPicker
                        ctx={ctx}
                        position={pick.rule === 'exclude' ? null : pick.position}
                        rule={pick.rule}
                        replacing={index}
                        autoFocus={true}
                        onPick={(o: PlanOption) => {
                            setSlotPlan(withPick(ctx.plan, index, pickOf(o, pick.rule), ctx.itemType));
                        }}
                        onClose={() => {
                            setChanging(false);
                        }}
                    />
                ) : (
                    <button
                        type="button"
                        class="plan-mod"
                        title="Change this mod"
                        onClick={() => {
                            setChanging(true);
                        }}
                    >
                        <span class="mod-text">{text}</span>
                        <span class="mod-meta">{option !== undefined && <InfluenceTag option={option} />}</span>
                        {single !== undefined && <span class="leader" aria-hidden="true" />}
                    </button>
                )}
                {single !== undefined && !changing && (
                    <StatRange ctx={ctx} index={index} stat={single} picked={pickedOf(single)} inline={true} />
                )}
                <button
                    type="button"
                    class="plan-clear"
                    aria-label={`Clear ${text}`}
                    title={pick.rule === 'exclude' ? 'Remove this exclude' : 'Clear this row'}
                    onClick={() => {
                        setSlotPlan(withoutPick(ctx.plan, index, ctx.itemType, ctx.equippedType));
                    }}
                >
                    <ClearIcon />
                </button>
            </div>
            {ranged.length > 1 && (
                <div class="plan-ranges">
                    {ranged.map((s: StatOption) => (
                        <StatRange key={s.statId} ctx={ctx} index={index} stat={s} picked={pickedOf(s)} />
                    ))}
                </div>
            )}
            {problem !== undefined && <p class="hint fail plan-row-problem">{problem}</p>}
        </li>
    );
}

/** An empty row: anything may roll there, or pick a mod to include (null position: the Exclude section's adder). */
function EmptyRow(props: { readonly ctx: Ctx; readonly position: ModPosition | null; readonly rule: ModRule }): JSX.Element {
    const { ctx, position, rule } = props;
    return (
        <li class={`plan-row empty rule-${rule}`}>
            <div class="plan-row-main">
                <ModPicker
                    ctx={ctx}
                    position={position}
                    rule={rule}
                    replacing={null}
                    autoFocus={false}
                    onPick={(o: PlanOption) => {
                        setSlotPlan(withPick(ctx.plan, null, pickOf(o, rule), ctx.itemType));
                    }}
                    onClose={() => {
                        // nothing to put back: the row stays empty
                    }}
                />
            </div>
        </li>
    );
}

function PlanSection(props: { readonly ctx: Ctx; readonly position: ModPosition }): JSX.Element {
    const { ctx, position } = props;
    const indices: readonly number[] = rowsOf(ctx.plan)[position];
    const limit: number = rowLimit(position, ctx.affixes);
    // Affixes show up to 3 rows, then a spare one while the base takes more (issue #37); implicits one spare row.
    const empties: number = emptyRows(position, indices.length, ctx.affixes);
    const includes: number = indices.length;
    const where: string = ctx.plan.base ?? `any ${ctx.itemType}`;
    return (
        <section class={`plan-section plan-${position}`} aria-label={POSITION_WORDS[position].title}>
            <h3 class="plan-section-head">
                {POSITION_WORDS[position].title}
                {position !== 'implicit' && (
                    <span class="muted small">
                        {' '}
                        · {includes} of {limit} included
                    </span>
                )}
            </h3>
            {position !== 'implicit' && limit === 0 && (
                <p class="muted small">
                    {where} has no {POSITION_WORDS[position].one}es.
                </p>
            )}
            <ul class="plan-rows">
                {indices.map((i: number) => {
                    const pick: ModPick | undefined = ctx.plan.picks[i];
                    return pick === undefined ? null : (
                        <FilledRow key={`${i}:${pick.group ?? ''}:${pick.stats[0]?.statId ?? ''}`} ctx={ctx} index={i} pick={pick} />
                    );
                })}
                {Array.from({ length: empties }, (_v: unknown, n: number) => (
                    <EmptyRow key={`empty-${indices.length + n}`} ctx={ctx} position={position} rule="include" />
                ))}
            </ul>
        </section>
    );
}

/** Mods no result may have (issue #29): any number, from any position, each costing 1 on the site's complexity. */
function ExcludeSection(props: { readonly ctx: Ctx }): JSX.Element {
    const { ctx } = props;
    const indices: readonly number[] = excludeRows(ctx.plan);
    return (
        <section class="plan-section plan-exclude" aria-label="Exclude">
            <h3 class="plan-section-head">
                <Info
                    tipKey="plan-exclude"
                    title="Exclude"
                    lines={[
                        'No result has any of these, whether the line is rolled, crafted or fractured.',
                        'They take no prefix or suffix row: exclude as many as you like. Each one costs a little of the search’s room; PoB’s weakest weights make way first.',
                    ]}
                >
                    Exclude
                </Info>
                {indices.length > 0 && <span class="muted small"> · {indices.length}</span>}
            </h3>
            <ul class="plan-rows">
                {indices.map((i: number) => {
                    const pick: ModPick | undefined = ctx.plan.picks[i];
                    return pick === undefined ? null : (
                        <FilledRow key={`x${i}:${pick.group ?? ''}:${pick.stats[0]?.statId ?? ''}`} ctx={ctx} index={i} pick={pick} />
                    );
                })}
                <EmptyRow key={`exclude-new-${indices.length}`} ctx={ctx} position={null} rule="exclude" />
            </ul>
        </section>
    );
}

function TypeAndBase(props: {
    readonly plan: SlotPlan;
    /** The types the slot can pick (Weapon 2: what fits beside Weapon 1, #39). */
    readonly offered: readonly string[];
    readonly itemType: string;
    readonly equippedType: string | null;
    readonly bases: readonly BaseOption[] | undefined;
}): JSX.Element {
    const { plan, offered, itemType, equippedType, bases } = props;
    // A saved plan's type that no longer fits (Weapon 1 changed in PoB) still shows, marked, until it's changed.
    const types: readonly string[] = offered.includes(itemType) ? offered : [itemType, ...offered];
    const sorted: readonly BaseOption[] = [...(bases ?? [])].sort(
        (a: BaseOption, b: BaseOption) => b.level - a.level || a.name.localeCompare(b.name),
    );
    const icon: string | null = sorted.find((b: BaseOption) => b.name === plan.base)?.icon ?? null;
    return (
        <div class="plan-base row">
            <span class={`plan-base-art${icon === null ? ' empty' : ''}`} aria-hidden="true">
                {icon !== null && <img src={icon} alt="" loading="lazy" draggable={false} />}
            </span>
            {types.length > 1 && (
                <div class="field">
                    <label for="plan-type">Item type</label>
                    <select
                        id="plan-type"
                        value={itemType}
                        onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                            setSlotPlan(withItemType(plan, e.currentTarget.value, equippedType));
                        }}
                    >
                        {types.map((t: string) => (
                            <option key={t} value={t}>
                                {offered.includes(t) ? (t === equippedType ? `${t} (equipped)` : t) : `${t} (doesn't fit beside Weapon 1)`}
                            </option>
                        ))}
                    </select>
                    <p class="hint">
                        {isGenericType(itemType)
                            ? 'Every weapon type in the group: totals only, since bases and mods are per item type. PoB’s weights are still for your equipped weapon.'
                            : 'Changing it clears the base, mods and defences.'}
                    </p>
                </div>
            )}
            {!isGenericType(itemType) && (
                <div class="field">
                    <label for="plan-base">Base</label>
                    <select
                        id="plan-base"
                        value={plan.base ?? ''}
                        disabled={bases === undefined}
                        onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                            const v: string = e.currentTarget.value;
                            setSlotPlan(withBase(plan, v === '' ? null : v, itemType, equippedType));
                        }}
                    >
                        <option value="">Any {itemType.toLowerCase()} base</option>
                        {plan.base !== null && !sorted.some((b: BaseOption) => b.name === plan.base) && (
                            <option value={plan.base}>{plan.base}</option>
                        )}
                        {sorted.map((b: BaseOption) => (
                            <option key={b.name} value={b.name}>
                                {`${b.name} · level ${b.level}${b.implicits.length > 0 ? ` · ${b.implicits.flatMap((i) => i.lines).join(', ')}` : ''}`}
                            </option>
                        ))}
                    </select>
                </div>
            )}
        </div>
    );
}

/** One defence's min/max on the item as listed (issue #24). */
function DefenceRangeRow(props: { readonly ctx: Ctx; readonly kind: DefenceKind }): JSX.Element {
    const { ctx, kind } = props;
    const range: DefenceRange = ctx.plan.defences?.[kind] ?? {};
    const [minText, setMinText] = useState<string>(rollText(range.min));
    const [maxText, setMaxText] = useState<string>(rollText(range.max));
    useEffect(() => {
        setMinText(rollText(range.min));
        setMaxText(rollText(range.max));
    }, [range.min, range.max]);
    const min: number | null | undefined = parseDefence(minText);
    const max: number | null | undefined = parseDefence(maxText);
    const name: string = DEFENCE_LABELS[kind];
    const commit = (end: 'min' | 'max', value: number | null | undefined): void => {
        if (value === undefined || value === (range[end] ?? null)) {
            return;
        }
        setSlotPlan(withDefence(ctx.plan, kind, end, value, ctx.itemType, ctx.equippedType));
    };
    let problem: string | undefined;
    if (min === undefined || max === undefined) {
        problem = 'Type a whole number from 0, or leave it empty for no limit.';
    } else if (min !== null && max !== null && min > max) {
        problem = 'The min is above the max.';
    }
    const box = (end: 'min' | 'max', text: string, set: (t: string) => void, value: number | null | undefined): JSX.Element => (
        <input
            class="num roll-input defence-input"
            inputMode="numeric"
            aria-label={`${end === 'min' ? 'Min' : 'Max'} ${name}`}
            aria-invalid={value === undefined}
            placeholder="any"
            value={text}
            onInput={(e: TargetedEvent<HTMLInputElement>) => {
                set(e.currentTarget.value);
            }}
            onChange={() => {
                commit(end, value);
            }}
            onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                    commit(end, value);
                }
            }}
        />
    );
    return (
        <div class={`stat-range defence-range defence-${kind}`}>
            <span class="stat-range-label">{name}</span>
            {box('min', minText, setMinText, min)}
            <span class="muted small">to</span>
            {box('max', maxText, setMaxText, max)}
            {problem !== undefined && <span class="hint fail stat-range-problem">{problem}</span>}
        </div>
    );
}

/** The item's defences, on item types that have any: a pure armour base is max Evasion 0 and max Energy Shield 0. */
function DefencesSection(props: { readonly ctx: Ctx }): JSX.Element | null {
    const kinds: readonly DefenceKind[] = defenceKindsOf(props.ctx.data);
    if (kinds.length === 0) {
        return null;
    }
    return (
        <section class="plan-section plan-defences" aria-label="Defences">
            <h3 class="plan-section-head">
                <Info
                    tipKey="plan-defences"
                    title="Defences"
                    lines={[
                        'A range on the item’s Armour, Evasion, Energy Shield or Ward as the trade site counts it: at 20% quality. A 0% quality item listed with 420 Armour counts as 504, so a min of 500 finds it.',
                        'Max 0 means none of it: max Evasion 0 and max Energy Shield 0 finds pure armour bases. Mods that add a defence set to 0 leave the weights.',
                        'Empty boxes are no limit.',
                    ]}
                >
                    Defences
                </Info>
            </h3>
            <div class="plan-ranges">
                {kinds.map((k: DefenceKind) => (
                    <DefenceRangeRow key={k} ctx={props.ctx} kind={k} />
                ))}
            </div>
        </section>
    );
}

/** One total with its min/max (issue #26). */
function TotalRow(props: { readonly ctx: Ctx; readonly total: PlanTotal }): JSX.Element {
    const { ctx, total } = props;
    const [minText, setMinText] = useState<string>(rollText(total.min));
    const [maxText, setMaxText] = useState<string>(rollText(total.max));
    useEffect(() => {
        setMinText(rollText(total.min));
        setMaxText(rollText(total.max));
    }, [total.min, total.max]);
    const min: number | null | undefined = parseRoll(minText);
    const max: number | null | undefined = parseRoll(maxText);
    const counts: string | null = ctx.data.totals.find((o: TotalOption) => o.id === total.statId)?.counts ?? null;
    const commit = (end: 'min' | 'max', value: number | null | undefined): void => {
        if (value === undefined || value === (total[end] ?? null)) {
            return;
        }
        setSlotPlan(withTotalRange(ctx.plan, total.statId, end, value, ctx.itemType, ctx.equippedType));
    };
    let problem: string | undefined;
    if (min === undefined || max === undefined) {
        problem = 'Type a number, or leave it empty for no limit.';
    } else if (min !== null && max !== null && min > max) {
        problem = 'The min is above the max.';
    }
    const box = (end: 'min' | 'max', text: string, set: (t: string) => void, value: number | null | undefined): JSX.Element => (
        <input
            class="num roll-input total-input"
            inputMode="decimal"
            aria-label={`${end === 'min' ? 'Min' : 'Max'} for ${total.text}`}
            aria-invalid={value === undefined}
            placeholder="any"
            value={text}
            onInput={(e: TargetedEvent<HTMLInputElement>) => {
                set(e.currentTarget.value);
            }}
            onChange={() => {
                commit(end, value);
            }}
            onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                    commit(end, value);
                }
            }}
        />
    );
    return (
        <div class="stat-range total-range">
            <span class="stat-range-label">
                <span class="mod-kind pseudo">Pseudo</span>{' '}
                {counts === null ? (
                    total.text
                ) : (
                    <Info tipKey={`total:${total.statId}`} title={total.text} lines={[`Counts ${counts}.`]}>
                        {total.text}
                    </Info>
                )}
            </span>
            {box('min', minText, setMinText, min)}
            <span class="muted small">to</span>
            {box('max', maxText, setMaxText, max)}
            <button
                type="button"
                class="plan-clear"
                aria-label={`Remove ${total.text}`}
                onClick={() => {
                    setSlotPlan(withoutTotal(ctx.plan, total.statId, ctx.itemType, ctx.equippedType));
                }}
            >
                <ClearIcon />
            </button>
            {problem !== undefined && <span class="hint fail stat-range-problem">{problem}</span>}
        </div>
    );
}

/** The searchable list of the site's pseudo totals: type to narrow, arrows and Enter to add, Escape to close. */
function TotalPicker(props: { readonly ctx: Ctx }): JSX.Element {
    const { ctx } = props;
    const [query, setQuery] = useState<string>('');
    const [open, setOpen] = useState<boolean>(false);
    const [active, setActive] = useState<number>(0);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);
    const listed: readonly TotalOption[] = open ? listTotals(ctx.data.totals, ctx.plan, query) : [];
    useEffect(() => {
        list.current?.querySelector('.mod-option.active')?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);
    const add = (o: TotalOption | undefined): void => {
        if (o === undefined) {
            return;
        }
        setSlotPlan(withTotal(ctx.plan, o, ctx.itemType, ctx.equippedType));
        setQuery('');
        setOpen(false);
        input.current?.blur();
    };
    return (
        <div class="mod-picker">
            <input
                ref={input}
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls="picker-totals-list"
                aria-activedescendant={open && listed[active] !== undefined ? `picker-totals-${active}` : undefined}
                aria-autocomplete="list"
                aria-label="Search pseudo totals"
                placeholder="Add a total: life, resistances, attributes… from any source"
                value={query}
                onFocus={() => {
                    setOpen(true);
                }}
                onBlur={() => {
                    setOpen(false);
                }}
                onInput={(e: TargetedEvent<HTMLInputElement>) => {
                    setQuery(e.currentTarget.value);
                    setActive(0);
                    setOpen(true);
                }}
                onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setOpen(true);
                        setActive(Math.min(active + 1, Math.max(0, listed.length - 1)));
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setActive(Math.max(0, active - 1));
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        add(listed[active]);
                    } else if (e.key === 'Escape') {
                        setOpen(false);
                        input.current?.blur();
                    }
                }}
            />
            {open && (
                <ul class="mod-options" id="picker-totals-list" role="listbox" ref={list}>
                    {listed.length === 0 && <li class="mod-option none muted">Nothing matches “{query}”.</li>}
                    {listed.map((o: TotalOption, i: number) => (
                        <li
                            key={o.id}
                            id={`picker-totals-${i}`}
                            role="option"
                            aria-selected={i === active}
                            class={`mod-option${i === active ? ' active' : ''}`}
                            onMouseDown={(e: MouseEvent) => {
                                e.preventDefault();
                            }}
                            onMouseEnter={() => {
                                setActive(i);
                            }}
                            onClick={() => {
                                add(o);
                            }}
                        >
                            <span class="mod-text">{o.text}</span>
                            <span class="mod-meta">
                                <span class="mod-kind pseudo">Pseudo</span>
                                {o.counts !== null && <span class="muted">counts {o.counts}</span>}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** Totals from any source, as the site's Pseudo stats (issue #26): "+# total maximum Life ≥ 80" is met by life, Strength or both. */
function TotalsSection(props: { readonly ctx: Ctx }): JSX.Element {
    const { ctx } = props;
    const totals: readonly PlanTotal[] = totalsOf(ctx.plan);
    return (
        <section class="plan-section plan-totals" aria-label="Totals">
            <h3 class="plan-section-head">
                <Info
                    tipKey="plan-totals"
                    title="Totals"
                    lines={[
                        'The trade site’s pseudo stats: what the item gives in total, from any line. “+# total maximum Life” counts life, and half of the item’s Strength; a resistance total counts +all Elemental Resistances and hybrids.',
                        'A mod below means that mod itself must be on the item. Use a total when you don’t mind where the stat comes from.',
                        'Empty boxes are no limit.',
                    ]}
                >
                    Totals
                </Info>
            </h3>
            <div class="plan-ranges">
                {totals.map((t: PlanTotal) => (
                    <TotalRow key={t.statId} ctx={ctx} total={t} />
                ))}
            </div>
            {totals.length < MAX_TOTALS && <TotalPicker ctx={ctx} />}
        </section>
    );
}

/** The plan's own problems from main (core's checkPlan): anything here stops the search. */
function PlanProblems(props: { readonly slot: GearSlot }): JSX.Element | null {
    const wp = weightPreview.value;
    if (wp.kind !== 'ready' || wp.preview.slot !== props.slot || wp.preview.planProblems.length === 0) {
        return null;
    }
    return (
        <div class="plan-problems-box" role="alert">
            <p class="fail">The plan can't be searched yet:</p>
            <ul class="plan-problems">
                {wp.preview.planProblems.map((p: string) => (
                    <li key={p} class="fail small">
                        {p}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The plan in short, as chips under the title: base, includes, excludes, totals, each defence range, then the socket filters. */
function PlanSummary(props: { readonly plan: SlotPlan }): JSX.Element {
    const plan: SlotPlan = props.plan;
    if (isEmptySlotPlan(plan)) {
        return (
            <ul class="plan-summary">
                <li class="sum-empty">Empty: searches as before, by PoB’s weights only</li>
            </ul>
        );
    }
    const inc: number = plan.picks.filter((p: ModPick) => p.rule === 'include').length;
    const exc: number = plan.picks.length - inc;
    const totals: number = totalsOf(plan).length;
    return (
        <ul class="plan-summary" aria-label="The plan in short">
            <li class="sum-base">{plan.base ?? (plan.itemType === null ? 'Any base' : anyOfType(plan.itemType))}</li>
            {inc > 0 && <li class="sum-include">{`${inc} include${inc === 1 ? '' : 's'}`}</li>}
            {exc > 0 && <li class="sum-exclude">{`${exc} exclude${exc === 1 ? '' : 's'}`}</li>}
            {totals > 0 && <li class="sum-total">{`${totals} total${totals === 1 ? '' : 's'}`}</li>}
            {defenceSummaryParts(plan).map((d: string) => (
                <li key={d} class="sum-defence">
                    {d}
                </li>
            ))}
            {socketSummaryParts(plan).map((d: string) => (
                <li key={d} class="sum-sockets">
                    {d}
                </li>
            ))}
        </ul>
    );
}

/** Why the editor can't be used yet, or null. */
function blockedReason(slot: GearSlot, waiting: string | null, offered: readonly string[]): string | null {
    if (waiting !== null) {
        return waiting;
    }
    if (offered.length === 0) {
        return slot === 'Weapon 2' ? 'Weapon 1 is two-handed: nothing goes in Weapon 2.' : `${slot} has no item types to plan.`;
    }
    return null;
}

/**
 * The editor for one slot's plan. `waiting` says why the build's gear isn't known yet (PoB still loading, or
 * failed): until it is, the editor neither asks for slot data nor saves a type (#36). Weapon 2 offers only what
 * fits beside `weapon1Type` (#39).
 */
export function SlotPlanCard(props: {
    readonly slot: GearSlot;
    readonly equippedType: string | null;
    readonly weapon1Type: string | null;
    readonly waiting: string | null;
}): JSX.Element {
    const { slot, equippedType, weapon1Type, waiting } = props;
    const plan: SlotPlan = planFor(slot);
    const offered: readonly string[] = slotItemTypes(slot, weapon1Type);
    const blocked: string | null = blockedReason(slot, waiting, offered);
    const itemType: string = editorItemType(slot, plan, equippedType, weapon1Type);
    const key: string = editorDataKey(slot, itemType, plan.base);
    useEffect(() => {
        if (blocked === null) {
            void loadEditorData(slot, itemType, plan.base);
        }
    }, [key, blocked]);
    // Keep the last data for this type on screen while a new base loads, so the rows don't jump.
    const last = useRef<SlotEditorData | null>(null);
    const st = editorData.value;
    if (st.kind === 'ready' && st.key === key) {
        last.current = st.data;
    }
    const data: SlotEditorData | null =
        last.current !== null && last.current.slot === slot && last.current.itemType === itemType ? last.current : null;
    const stale: boolean = data !== null && data.base !== plan.base;
    const options: readonly PlanOption[] = useOptions(data);
    const ctx: Ctx | null =
        data === null
            ? null
            : {
                  data: data,
                  options: options,
                  plan: plan,
                  affixes: planAffixes(data, plan.base),
                  itemType: itemType,
                  equippedType: equippedType,
              };
    return (
        <div class="card plan-card">
            <div class="plan-head">
                <h2>
                    <Info
                        tipKey="plan-h"
                        title="Slot plan"
                        lines={[
                            'Say what the item must have and must not have. Include: every result has that mod (with a roll range if you set one). Exclude: no result has it. Empty rows are free: anything may roll there.',
                            'A range is on the item’s total for that stat, so a hybrid or a bench craft can meet it too.',
                            'PoB still scores every listing against your build; the plan only decides which listings come back.',
                        ]}
                    >
                        Slot plan
                    </Info>
                </h2>
                <PlanSummary plan={plan} />
                {unsaved.value !== null && unsaved.value.buildId === selectedBuildId.value && (
                    <span class="plan-unsaved">
                        Not saved ·{' '}
                        <button type="button" class="link small" onClick={retrySave}>
                            Retry
                        </button>
                    </span>
                )}
                {!isEmptySlotPlan(plan) && (
                    <span class="plan-actions">
                        {plan.picks.length > 0 && (
                            <button
                                type="button"
                                class="link small"
                                onClick={() => {
                                    setSlotPlan(withoutPicks(plan, itemType, equippedType));
                                }}
                            >
                                Clear mods
                            </button>
                        )}
                        <button
                            type="button"
                            class="link small"
                            title="Back to an empty plan: search as before"
                            onClick={() => {
                                setSlotPlan({ slot: slot, itemType: null, base: null, picks: [] });
                            }}
                        >
                            Reset plan
                        </button>
                    </span>
                )}
            </div>
            {blocked !== null && <p class="muted">{blocked}</p>}
            {blocked === null && (
                <TypeAndBase plan={plan} offered={offered} itemType={itemType} equippedType={equippedType} bases={data?.bases} />
            )}
            {blocked === null && st.kind === 'error' && st.key === key && <p class="fail">{st.message}</p>}
            {blocked === null && ctx === null && st.kind !== 'error' && (
                <p class="muted">PoB is listing the {itemType.toLowerCase()} mods…</p>
            )}
            {blocked === null && ctx !== null && (
                <div class={`plan-item${stale ? ' stale' : ''}`} aria-busy={stale}>
                    {isGenericType(itemType) ? (
                        // A generic weapon type (#39): no slot data, so totals (and socket filters) only.
                        <>
                            <TotalsSection ctx={ctx} />
                            <SocketFilters plan={ctx.plan} />
                        </>
                    ) : (
                        <>
                            <DefencesSection ctx={ctx} />
                            <TotalsSection ctx={ctx} />
                            <SocketFilters plan={ctx.plan} />
                            <PlanSection ctx={ctx} position="implicit" />
                            <PlanSection ctx={ctx} position="prefix" />
                            <PlanSection ctx={ctx} position="suffix" />
                            <ExcludeSection ctx={ctx} />
                        </>
                    )}
                </div>
            )}
            <PlanProblems slot={slot} />
        </div>
    );
}

/** The options for the data, worked out once per data. */
function useOptions(data: SlotEditorData | null): readonly PlanOption[] {
    const memo = useRef<{ readonly data: SlotEditorData | null; readonly options: readonly PlanOption[] }>({ data: null, options: [] });
    if (memo.current.data !== data) {
        memo.current = { data: data, options: data === null ? [] : planOptions(data) };
    }
    return memo.current.options;
}
