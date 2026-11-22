// The Run view (PLAN.md, UI): live while searching (good finds with buy links, bands, the rate-limit panel,
// Pause/Cancel, the feed), then the results summary in the same view (verdict, run summary, shortlist with
// the filtered groups one click away, item detail).

import { useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import type { FeedEntry, HiddenReason, StatChange, UiBand, LimitPanel, RunHeader, RunSnapshot, RunSummaryUi, SearchedStat, UiItem } from '@poe-upgrade-finder/ipc';
import { HIDDEN_REASONS } from '@poe-upgrade-finder/ipc';
import { compact, signedPct } from '../format.ts';
import { bestPerBand, chartModel } from '../chart-model.ts';
import type { BandBest, ChartModel } from '../chart-model.ts';
import { go } from '../router.ts';
import { HoverItem, Info, ItemCard, ItemImage } from './item-card.tsx';
import { Orb, Price } from './price.tsx';
import { LimitMeters, LimitsStrip } from './limits.tsx';
import { PriceGainChart } from './price-gain-chart.tsx';
import { bandLabel, bandRows, blendText, byGain, goodFinds, HIDDEN_LABELS, hiddenCounts, isLive, liveFiltered, progress } from '../run-model.ts';
import type { BandRow } from '../run-model.ts';
import { openLogLine } from '../state/log-focus.ts';
import { cancelRun, deepening, deepenRun, limits, linkMessage, openBuyLink, pauseRun, resumeRun, run } from '../state/run.ts';

function gainText(n: number | null): string {
    return n === null ? 'n/a' : signedPct(n);
}

// Items ----------------------------------------------------------------------------------------------------

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
    'Pick': ['The best value for money in your budget that clears the floors and the minimum gain: the cheapest item within 80% of the best gain on offer.'],
    'Best gain': ['The biggest overall gain in your budget among items that pass the floors. Not a pick: it is under the minimum gain, or a cheaper item comes close enough.'],
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
                    <span class="num">{c.delta > 0 ? '+' : '−'}{Math.abs(c.delta).toLocaleString('en-GB')}{c.unit}</span> {c.label}
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
            <h3 class="detail-h">Against your {props.header.currentItem}</h3>
            <Changes changes={i.changes} />
            {i.failedFloors.length > 0 && <p class="fail">Breaks: {i.failedFloors.join('; ')}</p>}
            {i.flags.length > 0 && <p class="warn">Flags: {i.flags.join('; ')}</p>}
            {i.missedTargets.length > 0 && <p class="warn">Below target: {i.missedTargets.join('; ')}</p>}
            {i.notes.map((n: string, k: number) => <p key={k} class="muted">{n}</p>)}
            {i.unparsed.length > 0 && <p class="warn">PoB didn't read: {i.unparsed.join('; ')}</p>}
            {(i.view !== null || current !== null) && (
                <div class="compare">
                    {i.view !== null && <figure><figcaption class="muted small">This listing</figcaption><ItemCard view={i.view} /></figure>}
                    {current !== null && <figure><figcaption class="muted small">Equipped now</figcaption><ItemCard view={current} /></figure>}
                </div>
            )}
            <details class="itemtext-box" open={i.view === null}>
                <summary class="muted small">Item text</summary>
                <pre class="itemtext">{i.text}</pre>
            </details>
        </div>
    );
}

function tone(n: number | null): string {
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
                    <button type="button" class={`find-name r-${i.view?.rarity ?? 'rare'}`} aria-expanded={props.open} onClick={props.onToggle}>
                        <span class="name"><span class={`chev${props.open ? ' open' : ''}`} aria-hidden="true">▸</span>{i.name || i.baseType}</span>
                        <span class="muted base">{i.name ? i.baseType : ''}{i.itemLevel !== null ? ` · ilvl ${i.itemLevel}` : ''}</span>
                    </button>
                </HoverItem>
                <span class="find-meta">
                    {props.tag !== undefined && (
                        <Info tipKey={`${key}:tag`} title={props.tag} lines={TAG_INFO[props.tag] ?? []} class="tag">{props.tag}</Info>
                    )}
                    <Info tipKey={`${key}:band`} title={`Price band: ${bandLabel(h, i.bandId)}`} class={`band-chip${band?.role === 'over' ? ' over' : ''}`} lines={[
                        'Found by this band\'s own searches. Each price band is searched separately so cheap listings aren\'t crowded out by expensive ones.',
                        ...(band?.role === 'over' ? ['Just over your budget: shown for comparison, never picked.'] : []),
                    ]}>{bandLabel(h, i.bandId)}</Info>
                </span>
                <span class="find-gain num">
                    <Info tipKey={`${key}:overall`} title="Overall gain" lines={[
                        `${blendText(h.blend)} of the change PoB computes with this item instead of your ${h.currentItem}.`,
                        `Set the blend in Settings. Items need at least +${h.minGainPct}% to be worth a look.`,
                    ]}>
                        <strong class={tone(i.gainPct)}>{gainText(i.gainPct)}</strong> <span class="muted">overall</span>
                    </Info>
                    <span class="sub">
                        <Info tipKey={`${key}:dps`} title={`DPS ${gainText(i.dpsPct)}`} lines={[`PoB's damage (${h.targetLabel}) with this item equipped, against ${compact(h.baselineDamage)} now.`]}>
                            <span class="muted">DPS</span> <span class={tone(i.dpsPct)}>{gainText(i.dpsPct)}</span>
                        </Info>
                        <Info tipKey={`${key}:ehp`} title={`EHP ${gainText(i.ehpPct)}`} lines={[`PoB's effective health pool (Calcs tab, "Total EHP") with this item equipped${h.baselineEhp !== null ? `, against ${compact(h.baselineEhp)} now` : ''}: how much damage you can take after armour, resistances, block and the rest.`]}>
                            <span class="muted">EHP</span> <span class={tone(i.ehpPct)}>{gainText(i.ehpPct)}</span>
                        </Info>
                    </span>
                </span>
                <span class="find-price"><Price tipKey={`${key}:price`} price={i.price} chaos={i.chaos} chaosPerDivine={h.chaosPerDivine} /></span>
                <span class="find-actions">
                    <button type="button" class={`btn compare-btn${props.open ? ' on' : ''}`} aria-expanded={props.open} onClick={props.onToggle}>{props.open ? 'Close' : 'Compare'}</button>
                    <button type="button" class="btn" disabled={!i.hasBuyLink} onClick={() => void openBuyLink(h.runId, i.id)}>Open on trade</button>
                </span>
            </div>
            {msg !== null && msg.itemId === i.id && <p class="muted small">{msg.text}</p>}
            {props.open && <ItemDetail item={i} header={h} />}
        </li>
    );
}

/** What the percentages mean: PoB's change to the build, and how "overall" blends DPS and EHP. */
function GainKey(props: { readonly header: RunHeader }): JSX.Element {
    return (
        <p class="muted small">
            Percentages are PoB's change to your build with the item equipped instead of your current one. Overall = {blendText(props.header.blend)} (the blend in Settings).
        </p>
    );
}

function ItemList(props: { readonly header: RunHeader; readonly items: readonly UiItem[]; readonly tags?: ReadonlyMap<string, string>; readonly empty: string; readonly scope: string; readonly hint?: boolean }): JSX.Element {
    const [openId, setOpenId] = useState<string | null>(null);
    if (props.items.length === 0) {
        return <p class="muted">{props.empty}</p>;
    }
    return (
        <>
        {props.hint !== false && <p class="muted small list-hint">Click a find (or Compare) for what it changes against your current item, side by side.</p>}
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

// Side panels ----------------------------------------------------------------------------------------------

/** The item in the slot now, so every find can be read against it (hover for its card). */
function NowEquipped(props: { readonly header: RunHeader }): JSX.Element {
    const h: RunHeader = props.header;
    const v = h.currentView;
    return (
        <div class="card side now-card">
            <h2>Equipped now · {h.slot}</h2>
            <HoverItem tipKey="now-equipped" view={v} class="now-item">
                <span class="now-icon">{v !== null && <ItemImage view={v} size="row" />}</span>
                <span class="now-text">
                    <span class={`name r-${v?.rarity ?? 'none'}`}>{v === null ? h.currentItem : v.name || v.typeLine}</span>
                    {v !== null && v.name !== '' && <span class="muted small">{v.typeLine}</span>}
                    <span class="muted small num">Build now: {compact(h.baselineDamage)} DPS{h.baselineEhp !== null ? ` · ${compact(h.baselineEhp)} EHP` : ''}</span>
                </span>
            </HoverItem>
        </div>
    );
}

const STATUS_TEXT: Readonly<Record<BandRow['status'], string>> = { waiting: 'Waiting', searching: 'Searching', done: 'Done', refused: 'Refused' };
const STATUS_INFO: Readonly<Record<BandRow['status'], string>> = {
    waiting: 'Not searched yet: bands run cheapest first.',
    searching: 'Its two searches (chaos-priced and divine-priced listings) are running, and its listings are being fetched and scored.',
    done: 'Searched, and every planned listing fetched and scored.',
    refused: 'The trade site refused this band\'s searches; the Activity list says why.',
};

/** The band tracker: one step per price band, joined by a line, each with its own progress bar. */
function Bands(props: { readonly snap: RunSnapshot }): JSX.Element {
    const rows: BandRow[] = bandRows(props.snap);
    return (
        <div class="card side">
            <h2>Price bands</h2>
            <ol class="tracker">
                {rows.map((r: BandRow) => (
                    <li key={r.band.id} class={`step ${r.status}${r.band.role === 'over' ? ' over' : ''}`}>
                        <span class="step-node" aria-hidden="true">{r.status === 'done' ? '✓' : r.status === 'refused' ? '!' : ''}</span>
                        <div class="step-body">
                            <div class="step-head">
                                <span class="step-label">{r.band.label}</span>
                                <Info tipKey={`band-status:${r.band.id}`} title={STATUS_TEXT[r.status]} lines={[STATUS_INFO[r.status]]} class={`band-status ${r.status}`}>{STATUS_TEXT[r.status]}</Info>
                            </div>
                            <ProgressBar value={r.scored} max={Math.max(r.planned, r.scored)} tone={r.status} label={`${r.band.label}: listings scored`} />
                            <div class="step-foot muted small num">
                                <Info tipKey={`band-count:${r.band.id}`} title="Matches and scored" lines={[
                                    'Matches: listings the trade site found in this band, chaos and divine searches together (it stops counting at 10,000 per search).',
                                    'Scored: listings fetched and run through PoB. Unidentified items and items that don\'t fit the slot are skipped.',
                                ]}>
                                    {r.matches === null ? 'not searched yet' : `${compact(r.matches)}${r.matchesCapped ? '+' : ''} matches · ${r.scored} of ${r.planned} scored`}
                                </Info>
                                {r.best !== null && <span class={r.best > 0 ? 'pass' : 'neg'}>best {signedPct(r.best)}</span>}
                            </div>
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
}

const SEARCHED_SHOWN: number = 8;

/** What the searches asked the site for: the hard needs, then PoB's weighted stats by name, heaviest first. */
function SearchedFor(props: { readonly header: RunHeader }): JSX.Element {
    const h: RunHeader = props.header;
    const [all, setAll] = useState<boolean>(false);
    const shown: readonly SearchedStat[] = all ? h.searchedFor : h.searchedFor.slice(0, SEARCHED_SHOWN);
    const top: number = h.searchedFor[0]?.weight ?? 1;
    return (
        <div class="card side">
            <h2>What it searched for</h2>
            {h.hardNeeds.length > 0 && <p class="small">Must have: {h.hardNeeds.join(', ')}</p>}
            <p class="muted small">PoB's weights for this build, heaviest first. Listings are ranked by the weighted sum of these.</p>
            <ul class="searched">
                {shown.map((s: SearchedStat) => (
                    <li key={s.statId} title={s.statId}>
                        <span class="searched-label">{s.label}</span>
                        <span class="num muted">{Math.round((s.weight / top) * 100)}%</span>
                        <svg class="weight-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
                            <rect class="track" x="0" y="0" width="100" height="4" rx="2" />
                            <rect class="fill" x="0" y="0" width={Math.max(1, (s.weight / top) * 100)} height="4" rx="2" />
                        </svg>
                    </li>
                ))}
            </ul>
            {h.searchedFor.length > SEARCHED_SHOWN && (
                <button type="button" class="btn small-btn" onClick={() => {
                    setAll(!all);
                }}>{all ? 'Show fewer' : `Show all ${h.searchedFor.length}`}</button>
            )}
        </div>
    );
}

/** The full meters, while a run goes (the rail's gauge keeps them in view afterwards). */
function Limits(props: { readonly panel: LimitPanel | null }): JSX.Element {
    return (
        <div class="card side">
            <h2>
                <Info tipKey="limits-h" title="Rate limits" lines={[
                    "The trade site's limits, read from its own response headers. The app keeps 30% headroom on every window and waits rather than retrying into a lockout.",
                    "Each bar is one window: calls made in it, out of the app's share. After the run they stay in view as the gauge in the left rail.",
                ]}>Rate limits</Info>
            </h2>
            <LimitMeters panel={props.panel} />
        </div>
    );
}

function Feed(props: { readonly feed: readonly FeedEntry[]; readonly runId: string }): JSX.Element {
    return (
        <div class="card side">
            <h2>Activity</h2>
            {props.feed.length === 0 ? <p class="muted">Nothing yet.</p> : (
                <ul class="feed" aria-live="polite">
                    {[...props.feed].reverse().slice(0, 60).map((e: FeedEntry, k: number) => (
                        <li key={k}>
                            <span class="time num">{new Date(e.atMs).toLocaleTimeString('en-GB')}</span>
                            <span class={`lvl ${e.level}`}>{e.level}</span>
                            <span>
                                {e.text}
                                {e.level !== 'info' && (
                                    <>
                                        {' '}
                                        <button type="button" class="link small" onClick={() => {
                                            openLogLine({ runId: props.runId, level: e.level === 'error' ? 'error' : 'warn', atMs: e.atMs, text: e.text });
                                        }}>Open in logs</button>
                                    </>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** An SVG bar: the CSP allows no inline styles, and an SVG width is an attribute. */
function ProgressBar(props: { readonly value: number; readonly max: number; readonly tone?: string; readonly label?: string }): JSX.Element {
    const pct: number = Math.max(0, Math.min(100, (props.value / Math.max(1, props.max)) * 100));
    return (
        <svg class={`bar${props.tone === undefined ? '' : ` ${props.tone}`}`} viewBox="0 0 100 8" preserveAspectRatio="none" role="progressbar" aria-label={props.label ?? 'Listings scored'} aria-valuemin={0} aria-valuemax={props.max} aria-valuenow={props.value}>
            <rect class="track" x="0" y="0" width="100" height="8" rx="4" />
            <rect class="fill" x="0" y="0" width={pct} height="8" rx="4" />
        </svg>
    );
}

// Live and done --------------------------------------------------------------------------------------------

function Live(props: { readonly snap: RunSnapshot }): JSX.Element {
    const { snap } = props;
    const h: RunHeader = snap.header;
    const finds: UiItem[] = goodFinds(snap.items, h.minGainPct);
    const filtered = liveFiltered(snap.items, h.minGainPct);
    const p = progress(snap);
    return (
        <div class="card">
            <div class="progress-line">
                <span class="num">{p.scored} of ~{p.expected} listings scored · band {Math.max(p.bandIndex, 1)} of {p.bands}</span>
            </div>
            <ProgressBar value={p.scored} max={p.expected} />
            <h2 class="spaced">Found so far</h2>
            <p class="hint">Passing the floors and gaining at least +{h.minGainPct}%, best first. Buy quickly: listings move.</p>
            <GainKey header={h} />
            <ItemList header={h} items={finds} scope="live" empty="Nothing yet: good finds appear here as PoB scores them." />
            {filtered.total > 0 && (
                <p class="muted small">Filtered out so far: {filtered.total} · {filtered.sideGrade} under +{h.minGainPct}% · {filtered.floor} break a floor</p>
            )}
        </div>
    );
}

/** The top of each price point, whether or not it cleared the minimum gain. */
function BestPerBand(props: { readonly header: RunHeader; readonly items: readonly UiItem[]; readonly tags: ReadonlyMap<string, string> }): JSX.Element {
    const rows: BandBest[] = bestPerBand(props.items, props.header.bands);
    return (
        <div class="card">
            <h2>Best per band</h2>
            <table class="band-best">
                <thead>
                    <tr><th>Band</th><th>Best that passes the floors</th><th class="num">Overall</th><th class="num">Price</th><th class="num">Worth a look</th></tr>
                </thead>
                <tbody>
                    {rows.map((r: BandBest) => (
                        <tr key={r.band.id}>
                            <td>{r.band.label}</td>
                            {r.best === null
                                ? <td class="muted" colSpan={3}>{r.scored === 0 ? 'Nothing scored' : 'Nothing passed the floors'}</td>
                                : (
                                    <>
                                        <td>{r.best.name || r.best.baseType}{props.tags.has(r.best.id) && <span class="tag">{props.tags.get(r.best.id)}</span>}</td>
                                        <td class={`num ${r.best.gainPct !== null && r.best.gainPct >= props.header.minGainPct ? 'pass' : 'muted'}`}>{gainText(r.best.gainPct)}</td>
                                        <td class="num">{r.best.price === null ? 'no price' : <Orb currency={r.best.price.currency} amount={r.best.price.amount} />}</td>
                                    </>
                                )}
                            <td class="num">{r.worth} of {r.scored}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** One short reason under the verdict: a coloured label and a few words, with an explanation on hover. */
function Reason(props: { readonly tipKey: string; readonly tone: 'pass' | 'warn' | 'info' | 'neg'; readonly label: string; readonly lines: readonly string[]; readonly children: ComponentChildren }): JSX.Element {
    return (
        <li class={`reason ${props.tone}`}>
            <Info tipKey={props.tipKey} title={props.label} lines={props.lines} class="reason-label">{props.label}</Info>
            <span class="reason-text">{props.children}</span>
        </li>
    );
}

function chaosText(n: number | null): string {
    return n === null ? '?' : `${n >= 100 ? Math.round(n).toLocaleString('en-GB') : n.toFixed(1)}c`;
}

/** The verdict: the pick (or the best that wasn't enough) as a large row, and the reasons as short points. */
function Verdict(props: { readonly snap: RunSnapshot; readonly summary: RunSummaryUi; readonly pick: UiItem | undefined; readonly best: UiItem | undefined; readonly tags: ReadonlyMap<string, string> }): JSX.Element {
    const { summary, pick, best } = props;
    const h: RunHeader = props.snap.header;
    const isPick: boolean = summary.verdict === 'pick' && pick !== undefined;
    const shown: UiItem | undefined = isPick ? pick : best;
    const over: number = summary.overBudgetIds.length;
    return (
        <div class={`card verdict ${summary.verdict}`}>
            <h2 class="verdict-h"><span class="verdict-mark" aria-hidden="true">{isPick ? '★' : '–'}</span>{isPick ? 'The pick' : 'No upgrade found'}</h2>
            <ul class="reasons" aria-label="Why">
                {isPick && pick !== undefined && (
                    <Reason tipKey="why-value" tone="pass" label="Best value" lines={[
                        'The cheapest item in budget whose overall gain is at least 80% of the best gain on offer, and at least the minimum gain.',
                        'Paying much more for the last few percent rarely makes sense; the best is named next to it so you can judge.',
                    ]}>
                        <strong class="pass">{gainText(pick.gainPct)}</strong> for <strong>{chaosText(pick.chaos)}</strong>
                    </Reason>
                )}
                {best !== undefined && (!isPick || best.id !== pick?.id) && (
                    <Reason tipKey="why-best" tone="info" label={isPick ? 'Best gain' : 'Best in budget'} lines={[
                        isPick ? 'The biggest overall gain in budget among items that pass the floors.' : 'The biggest overall gain in budget among items that pass the floors. It is shown below.',
                    ]}>
                        <HoverItem tipKey="why-best-item" view={best.view} class="reason-item"><span class={`reason-name r-${best.view?.rarity ?? 'rare'}`}>{best.name || best.baseType}</span></HoverItem>
                        {' '}<strong class={tone(best.gainPct)}>{gainText(best.gainPct)}</strong> for <strong>{chaosText(best.chaos)}</strong>
                    </Reason>
                )}
                {isPick && pick !== undefined && best !== undefined && best.id !== pick.id && pick.chaos !== null && best.chaos !== null && best.chaos > pick.chaos && (
                    <Reason tipKey="why-saves" tone="pass" label="Saves" lines={['What the pick costs less than the best gain, at the run\'s divine rate.']}>
                        <strong>{chaosText(best.chaos - pick.chaos)}</strong> against the best, for {gainText((best.gainPct ?? 0) - (pick.gainPct ?? 0)).replace('+', '')} less gain
                    </Reason>
                )}
                {!isPick && (
                    <Reason tipKey="why-min" tone="warn" label="Minimum" lines={[`Items need at least +${h.minGainPct}% overall to count as an upgrade. Change it in Settings.`]}>
                        {best === undefined ? 'nothing in budget passed the floors' : `needs +${h.minGainPct}% overall`}
                    </Reason>
                )}
                {over > 0 && (
                    <Reason tipKey="why-over" tone="info" label="Over budget" lines={['From the "slightly over budget" band. They beat everything in budget: tagged in the list below, never picked.']}>
                        {over} item{over === 1 ? '' : 's'} just over budget beat{over === 1 ? 's' : ''} these
                    </Reason>
                )}
            </ul>
            {shown !== undefined && <ItemList header={h} items={[shown]} tags={props.tags} scope="verdict" empty="" hint={false} />}
            {summary.stoppedReason !== null && <p class="warn">The run stopped early: {summary.stoppedReason}</p>}
        </div>
    );
}

type Group = 'shown' | HiddenReason | 'all';

function Done(props: { readonly snap: RunSnapshot; readonly summary: RunSummaryUi }): JSX.Element {
    const { snap, summary } = props;
    const h: RunHeader = snap.header;
    const [group, setGroup] = useState<Group>('shown');
    const byId: Map<string, UiItem> = new Map(summary.items.map((i: UiItem) => [i.id, i]));
    const pick: UiItem | undefined = summary.pickId === null ? undefined : byId.get(summary.pickId);
    const best: UiItem | undefined = summary.bestId === null ? undefined : byId.get(summary.bestId);
    const shown: UiItem[] = summary.items.filter((i: UiItem) => i.hidden === null).sort(byGain);
    const counts: Map<HiddenReason, number> = hiddenCounts(summary.items);
    const tags: Map<string, string> = new Map<string, string>();
    if (pick !== undefined) {
        tags.set(pick.id, 'Pick');
    }
    if (best !== undefined && best.id !== pick?.id) {
        tags.set(best.id, 'Best gain');
    }
    for (const id of summary.overBudgetIds) {
        tags.set(id, 'Over budget');
    }
    const listed: UiItem[] = group === 'shown' ? shown : group === 'all' ? [...summary.items].sort(byGain) : summary.items.filter((i: UiItem) => i.hidden === group).sort(byGain);
    const c = summary.counts;
    const chart: ChartModel | null = chartModel(summary.items, h);
    return (
        <>
            <Verdict snap={snap} summary={summary} pick={pick} best={best} tags={tags} />
            {chart !== null && <PriceGainChart model={chart} header={h} pickId={summary.pickId} />}
            <BestPerBand header={h} items={summary.items} tags={tags} />
            <div class="card">
                <h2>Run summary</h2>
                <div class="kpis">
                    <div class="kpi"><span class="kpi-value num">{c.scored}</span><span class="kpi-label">scored by PoB</span></div>
                    <div class="kpi"><span class={`kpi-value num${shown.length > 0 ? ' pass' : ''}`}>{shown.length}</span><span class="kpi-label">worth a look</span></div>
                    <div class="kpi"><span class={`kpi-value num ${tone(best?.gainPct ?? null)}`}>{best?.gainPct === null || best === undefined ? '–' : gainText(best.gainPct)}</span><span class="kpi-label">best gain in budget</span></div>
                    <div class="kpi"><span class="kpi-value num">{c.searches}</span><span class="kpi-label">searches · {c.fetched} fetched</span></div>
                    <div class="kpi"><span class="kpi-value num">{Math.round(summary.seconds)} s</span><span class="kpi-label">run time</span></div>
                </div>
                {(c.failed > 0 || c.missing > 0) && (
                    <p class="small">
                        {c.failed > 0 && <span class="warn">{c.failed} PoB couldn't score. </span>}
                        {c.missing > 0 && <span class="muted">{c.missing} gone before the fetch.</span>}
                    </p>
                )}
                <div class="groups" role="tablist" aria-label="Which items">
                    <button type="button" role="tab" aria-selected={group === 'shown'} class={group === 'shown' ? 'chip on' : 'chip'} onClick={() => {
                        setGroup('shown');
                    }}>Worth a look ({shown.length})</button>
                    {HIDDEN_REASONS.filter((r: HiddenReason) => (counts.get(r) ?? 0) > 0).map((r: HiddenReason) => (
                        <button key={r} type="button" role="tab" aria-selected={group === r} class={group === r ? 'chip on' : 'chip'} onClick={() => {
                            setGroup(r);
                        }}>{counts.get(r)} {HIDDEN_LABELS[r]}</button>
                    ))}
                    <button type="button" role="tab" aria-selected={group === 'all'} class={group === 'all' ? 'chip on' : 'chip'} onClick={() => {
                        setGroup('all');
                    }}>All ({summary.items.length})</button>
                </div>
                <ItemList header={h} items={listed} tags={tags} scope="list" empty={group === 'shown' ? 'Nothing cleared the floors and the minimum gain. The groups above show what was filtered out and why.' : 'Nothing in this group.'} />
            </div>
        </>
    );
}

export function RunView(): JSX.Element {
    const snap: RunSnapshot | null = run.value;
    if (snap === null) {
        return (
            <section class="page">
                <header class="page-head"><h1>Run</h1></header>
                <div class="card empty">
                    <p>No run yet.</p>
                    <button type="button" class="btn" onClick={() => {
                        go('search');
                    }}>Go to Search</button>
                </div>
            </section>
        );
    }
    const h: RunHeader = snap.header;
    const live: boolean = isLive(snap.phase);
    const finds: number = goodFinds(snap.items, h.minGainPct).length;
    const title: string = snap.phase === 'paused'
        ? `Paused · ${finds} good find${finds === 1 ? '' : 's'} so far`
        : live
            ? `Searching… ${finds} good find${finds === 1 ? '' : 's'} so far`
            : snap.phase === 'cancelled' ? 'Cancelled' : snap.phase === 'failed' ? 'The run failed' : 'Results';
    return (
        <section class="page wide">
            <header class="page-head run-head">
                <div>
                    <p class="crumbs muted">{h.buildName} / {h.slot}, max {h.budgetLabel} / {h.targetLabel} · baseline {compact(h.baselineDamage)} DPS{h.baselineEhp !== null ? `, ${compact(h.baselineEhp)} EHP` : ''} · now: {h.currentItem}</p>
                    <h1>{title}</h1>
                    {deepening.value.error !== null && !live && <p class="fail small">{deepening.value.error}</p>}
                </div>
                <div class="actions">
                    {snap.phase === 'searching' && <button type="button" class="btn" onClick={pauseRun}>Pause</button>}
                    {snap.phase === 'paused' && <button type="button" class="btn primary" onClick={resumeRun}>Resume</button>}
                    {live && <button type="button" class="btn" onClick={cancelRun}>Cancel</button>}
                    {snap.phase === 'done' && snap.summary !== null && h.depth !== 'thorough' && (
                        <button type="button" class="btn primary" disabled={deepening.value.busy} title="Score more of the same searches' listings (Thorough, 100 per band). No new searches." onClick={() => void deepenRun(h.runId)}>
                            {deepening.value.busy ? 'Starting…' : 'Search deeper'}
                        </button>
                    )}
                    {!live && deepening.value.busy && <button type="button" class="btn" onClick={cancelRun}>Cancel</button>}
                    {!live && <button type="button" class="btn" onClick={() => {
                        go('search');
                    }}>New search</button>}
                </div>
            </header>
            {!live && !deepening.value.busy && <LimitsStrip />}
            <div class="run-grid">
                <div class="run-main">
                    {snap.summary === null ? <Live snap={snap} /> : <Done snap={snap} summary={snap.summary} />}
                </div>
                <aside class="run-side">
                    <NowEquipped header={h} />
                    <Bands snap={snap} />
                    <SearchedFor header={h} />
                    {(live || deepening.value.busy) && <Limits panel={limits.value} />}
                    <Feed feed={snap.feed} runId={h.runId} />
                </aside>
            </div>
        </section>
    );
}
