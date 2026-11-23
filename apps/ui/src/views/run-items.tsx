// A find in the Run view: its row (name, gain, price, buy link), the detail with its stat changes and the
// side-by-side cards, and the lists of finds.

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { StatChange, UiBand, RunHeader, UiItem } from '@poe-upgrade-finder/ipc';
import { compact, signedPct } from '../format.ts';
import { HoverItem, Info, ItemCard, ItemImage } from './item-card.tsx';
import { Price } from './price.tsx';
import { bandLabel, blendText, currentItemText } from '../run-model.ts';
import { linkMessage, openBuyLink } from '../state/run.ts';
import { PlanChecks, PlanChip } from './plan-checks.tsx';

export function gainText(n: number | null): string {
    return n === null ? 'n/a' : signedPct(n);
}

interface ItemRowProps {
    readonly header: RunHeader;
    readonly item: UiItem;
    readonly tag: string | undefined;
    readonly open: boolean;
    readonly onToggle: () => void;
    /** Keeps tooltip keys unique when one item is listed twice (the pick and the list). */
    readonly tipScope: string;
}

const TAG_INFO: Readonly<Record<string, readonly string[]>> = {
    Pick: [
        'The best value for money in your budget that clears the floors and the minimum gain: the cheapest item within 80% of the best gain on offer.',
    ],
    'Best gain': [
        'The biggest overall gain in your budget among items that pass the floors. Not a pick: it is under the minimum gain, or a cheaper item comes close enough.',
    ],
    'Over budget': ['Beats everything in your budget, from the "slightly over budget" band. Shown so you can judge it; never picked.'],
};

/** The stat changes as chips: green when they go up, red when down (as PoB's compare does). */
function Changes(props: { readonly changes: readonly StatChange[] }): JSX.Element {
    if (props.changes.length === 0) {
        return <p class="muted small">No change to life, resistances, attributes or defences.</p>;
    }
    return (
        <ul class="changes" aria-label="Changes against your current item">
            {props.changes.map((c: StatChange) => (
                <li key={c.label} class={c.delta > 0 ? 'up' : 'down'}>
                    <span class="num">
                        {c.delta > 0 ? '+' : '−'}
                        {Math.abs(c.delta).toLocaleString('en-GB')}
                        {c.unit}
                    </span>{' '}
                    {c.label}
                </li>
            ))}
        </ul>
    );
}

function ItemDetail(props: { readonly item: UiItem; readonly header: RunHeader }): JSX.Element {
    const i: UiItem = props.item;
    const current = props.header.currentView;
    return (
        <div class="detail">
            <h3 class="detail-h">Against {currentItemText(props.header)}</h3>
            <Changes changes={i.changes} />
            <PlanChecks tipKey={`plan:${i.id}`} checks={i.planChecks} />
            {i.failedFloors.length > 0 && <p class="fail">Breaks: {i.failedFloors.join('; ')}</p>}
            {i.flags.length > 0 && <p class="warn">Flags: {i.flags.join('; ')}</p>}
            {i.missedTargets.length > 0 && <p class="warn">Below target: {i.missedTargets.join('; ')}</p>}
            {i.notes.map((n: string, k: number) => (
                <p key={k} class="muted">
                    {n}
                </p>
            ))}
            {i.unparsed.length > 0 && <p class="warn">PoB didn't read: {i.unparsed.join('; ')}</p>}
            {(i.view !== null || current !== null) && (
                <div class="compare">
                    {i.view !== null && (
                        <figure>
                            <figcaption class="muted small">This listing</figcaption>
                            <ItemCard view={i.view} />
                        </figure>
                    )}
                    {current !== null && (
                        <figure>
                            <figcaption class="muted small">Equipped now</figcaption>
                            <ItemCard view={current} />
                        </figure>
                    )}
                </div>
            )}
            <details class="itemtext-box" open={i.view === null}>
                <summary class="muted small">Item text</summary>
                <pre class="itemtext">{i.text}</pre>
            </details>
        </div>
    );
}

export function tone(n: number | null): string {
    return n === null || Math.abs(n) < 0.005 ? 'muted' : n > 0 ? 'pass' : 'neg';
}

function ItemRow(props: ItemRowProps): JSX.Element {
    const i: UiItem = props.item;
    const h: RunHeader = props.header;
    const msg = linkMessage.value;
    const key: string = `${props.tipScope}:${i.id}`;
    const band: UiBand | undefined = h.bands.find((b: UiBand) => b.id === i.bandId);
    return (
        <li class={props.tag === undefined ? 'find' : 'find tagged'}>
            <div class="find-main">
                <HoverItem tipKey={key} view={i.view} class="find-item">
                    <span class="find-icon">{i.view !== null && <ItemImage view={i.view} size="row" />}</span>
                    <button
                        type="button"
                        class={`find-name r-${i.view?.rarity ?? 'rare'}`}
                        aria-expanded={props.open}
                        onClick={props.onToggle}
                    >
                        <span class="name">
                            <span class={`chev${props.open ? ' open' : ''}`} aria-hidden="true">
                                <svg viewBox="0 0 16 16" width="14" height="14">
                                    <path d="M6 3.5 10.5 8 6 12.5" />
                                </svg>
                            </span>
                            {i.name || i.baseType}
                        </span>
                        <span class="muted base">
                            {i.name ? i.baseType : ''}
                            {i.itemLevel !== null ? ` · ilvl ${i.itemLevel}` : ''}
                        </span>
                    </button>
                </HoverItem>
                <span class="find-meta">
                    {props.tag !== undefined && (
                        <Info tipKey={`${key}:tag`} title={props.tag} lines={TAG_INFO[props.tag] ?? []} class="tag">
                            {props.tag}
                        </Info>
                    )}
                    <Info
                        tipKey={`${key}:band`}
                        title={`Price band: ${bandLabel(h, i.bandId)}`}
                        class={`band-chip${band?.role === 'over' ? ' over' : ''}`}
                        lines={[
                            "Found by this band's own searches. Each price band is searched separately so cheap listings aren't crowded out by expensive ones.",
                            ...(band?.role === 'over' ? ['Just over your budget: shown for comparison, never picked.'] : []),
                        ]}
                    >
                        {bandLabel(h, i.bandId)}
                    </Info>
                    <PlanChip tipKey={`${key}:plan`} checks={i.planChecks} />
                </span>
                <span class="find-gain num">
                    <Info
                        tipKey={`${key}:overall`}
                        title="Overall gain"
                        lines={[
                            `${blendText(h.blend)} of the change PoB computes with this item instead of ${currentItemText(h)}.`,
                            `Set the blend in Settings. Items need at least +${h.minGainPct}% to be worth a look.`,
                        ]}
                    >
                        <strong class={tone(i.gainPct)}>{gainText(i.gainPct)}</strong> <span class="muted">overall</span>
                    </Info>
                    <span class="sub">
                        <Info
                            tipKey={`${key}:dps`}
                            title={`DPS ${gainText(i.dpsPct)}`}
                            lines={[`PoB's damage (${h.targetLabel}) with this item equipped, against ${compact(h.baselineDamage)} now.`]}
                        >
                            <span class="muted">DPS</span> <span class={tone(i.dpsPct)}>{gainText(i.dpsPct)}</span>
                        </Info>
                        <Info
                            tipKey={`${key}:ehp`}
                            title={`EHP ${gainText(i.ehpPct)}`}
                            lines={[
                                `PoB's effective health pool (Calcs tab, "Total EHP") with this item equipped${h.baselineEhp !== null ? `, against ${compact(h.baselineEhp)} now` : ''}: how much damage you can take after armour, resistances, block and the rest.`,
                            ]}
                        >
                            <span class="muted">EHP</span> <span class={tone(i.ehpPct)}>{gainText(i.ehpPct)}</span>
                        </Info>
                    </span>
                </span>
                <span class="find-price">
                    <Price tipKey={`${key}:price`} price={i.price} chaos={i.chaos} chaosPerDivine={h.chaosPerDivine} />
                </span>
                <span class="find-actions">
                    <button
                        type="button"
                        class={`btn compare-btn${props.open ? ' on' : ''}`}
                        aria-expanded={props.open}
                        onClick={props.onToggle}
                    >
                        {props.open ? 'Close' : 'Compare'}
                    </button>
                    <button type="button" class="btn" disabled={!i.hasBuyLink} onClick={() => void openBuyLink(h.runId, i.id)}>
                        Open on trade
                    </button>
                </span>
            </div>
            {msg !== null && msg.itemId === i.id && <p class="muted small">{msg.text}</p>}
            {props.open && <ItemDetail item={i} header={h} />}
        </li>
    );
}

/** What the percentages mean: PoB's change to the build, and how "overall" blends DPS and EHP. */
export function GainKey(props: { readonly header: RunHeader }): JSX.Element {
    return (
        <p class="muted small">
            Percentages are PoB's change to your build with the item equipped instead of your current one. Overall ={' '}
            {blendText(props.header.blend)} (the blend in Settings).
        </p>
    );
}

export function ItemList(props: {
    readonly header: RunHeader;
    readonly items: readonly UiItem[];
    readonly tags?: ReadonlyMap<string, string>;
    readonly empty: string;
    readonly scope: string;
    readonly hint?: boolean;
}): JSX.Element {
    const [openId, setOpenId] = useState<string | null>(null);
    if (props.items.length === 0) {
        return <p class="muted">{props.empty}</p>;
    }
    return (
        <>
            {props.hint !== false && (
                <p class="muted small list-hint">Click a find (or Compare) for what it changes against your current item, side by side.</p>
            )}
            <ul class="finds">
                {props.items.map((i: UiItem) => (
                    <ItemRow
                        key={i.id}
                        header={props.header}
                        item={i}
                        tag={props.tags?.get(i.id)}
                        tipScope={props.scope}
                        open={openId === i.id}
                        onToggle={() => {
                            setOpenId(openId === i.id ? null : i.id);
                        }}
                    />
                ))}
            </ul>
        </>
    );
}
