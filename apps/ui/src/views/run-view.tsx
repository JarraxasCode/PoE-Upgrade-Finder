// The Run view (PLAN.md, UI): live while searching (good finds with buy links, bands, the rate-limit panel,
// Pause/Cancel, the feed), then the results summary in the same view (verdict, run summary, shortlist with
// the filtered groups one click away, item detail).

import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { FeedEntry, HiddenReason, RunHeader, RunSnapshot, RunSummaryUi, SearchedStat, UiItem } from '@poe-upgrade-finder/ipc';
import { HIDDEN_REASONS } from '@poe-upgrade-finder/ipc';
import { compact, signedPct } from '../format.ts';
import { bestPerBand, chartModel } from '../chart-model.ts';
import type { BandBest, ChartModel } from '../chart-model.ts';
import { go } from '../router.ts';
import { HoverItem, Info, ItemImage } from './item-card.tsx';
import { Orb } from './price.tsx';
import { LimitsStrip } from './limits.tsx';
import { PriceGainChart } from './price-gain-chart.tsx';
import { bandRows, byGain, goodFinds, HIDDEN_LABELS, hiddenCounts, isLive, liveFiltered, progress, slotWasEmpty } from '../run-model.ts';
import type { BandRow } from '../run-model.ts';
import { openLogLine } from '../state/log-focus.ts';
import { cancelRun, deepening, deepenRun, pauseRun, resumeRun, run } from '../state/run.ts';
import { gainText, tone, GainKey, ItemList } from './run-items.tsx';
import { Verdict } from './run-verdict.tsx';
import { RunPlanSummary } from './plan-checks.tsx';

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
                    <span class={`name r-${v?.rarity ?? 'none'}`}>
                        {v === null ? (slotWasEmpty(h) ? 'Nothing equipped' : h.currentItem) : v.name || v.typeLine}
                    </span>
                    {v !== null && v.name !== '' && <span class="muted small">{v.typeLine}</span>}
                    <span class="muted small num">
                        Build now: {compact(h.baselineDamage)} DPS{h.baselineEhp !== null ? ` · ${compact(h.baselineEhp)} EHP` : ''}
                    </span>
                </span>
            </HoverItem>
        </div>
    );
}

const STATUS_TEXT: Readonly<Record<BandRow['status'], string>> = {
    waiting: 'Waiting',
    searching: 'Searching',
    done: 'Done',
    refused: 'Refused',
};
const STATUS_INFO: Readonly<Record<BandRow['status'], string>> = {
    waiting: 'Not searched yet: bands run cheapest first.',
    searching: 'Its two searches (chaos-priced and divine-priced listings) are running, and its listings are being fetched and scored.',
    done: 'Searched, and every planned listing fetched and scored.',
    refused: "The trade site refused this band's searches; the Activity list says why.",
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
                        <span class="step-node" aria-hidden="true">
                            {r.status === 'done' ? '✓' : r.status === 'refused' ? '!' : ''}
                        </span>
                        <div class="step-body">
                            <div class="step-head">
                                <span class="step-label">{r.band.label}</span>
                                <Info
                                    tipKey={`band-status:${r.band.id}`}
                                    title={STATUS_TEXT[r.status]}
                                    lines={[STATUS_INFO[r.status]]}
                                    class={`band-status ${r.status}`}
                                >
                                    {STATUS_TEXT[r.status]}
                                </Info>
                            </div>
                            <ProgressBar
                                value={r.scored}
                                max={Math.max(r.planned, r.scored)}
                                tone={r.status}
                                label={`${r.band.label}: listings scored`}
                            />
                            <div class="step-foot muted small num">
                                <Info
                                    tipKey={`band-count:${r.band.id}`}
                                    title="Matches and scored"
                                    lines={[
                                        'Matches: listings the trade site found in this band, chaos and divine searches together (it stops counting at 10,000 per search).',
                                        "Scored: listings fetched and run through PoB. Unidentified items and items that don't fit the slot are skipped.",
                                    ]}
                                >
                                    {r.matches === null
                                        ? 'not searched yet'
                                        : `${compact(r.matches)}${r.matchesCapped ? '+' : ''} matches · ${r.scored} of ${r.planned} scored`}
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
            <RunPlanSummary header={h} />
            {h.hardNeeds.length > 0 && <p class="small">Build needs: {h.hardNeeds.join(', ')}</p>}
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
                <button
                    type="button"
                    class="btn small-btn"
                    onClick={() => {
                        setAll(!all);
                    }}
                >
                    {all ? 'Show fewer' : `Show all ${h.searchedFor.length}`}
                </button>
            )}
        </div>
    );
}

function Feed(props: { readonly feed: readonly FeedEntry[]; readonly runId: string }): JSX.Element {
    return (
        <div class="card side">
            <h2>Activity</h2>
            {props.feed.length === 0 ? (
                <p class="muted">Nothing yet.</p>
            ) : (
                <ul class="feed" aria-live="polite">
                    {[...props.feed]
                        .reverse()
                        .slice(0, 60)
                        .map((e: FeedEntry, k: number) => (
                            <li key={k}>
                                <span class="time num">{new Date(e.atMs).toLocaleTimeString('en-GB')}</span>
                                <span class={`lvl ${e.level}`}>{e.level}</span>
                                <span>
                                    {e.text}
                                    {e.level !== 'info' && (
                                        <>
                                            {' '}
                                            <button
                                                type="button"
                                                class="link small"
                                                onClick={() => {
                                                    openLogLine({
                                                        runId: props.runId,
                                                        level: e.level === 'error' ? 'error' : 'warn',
                                                        atMs: e.atMs,
                                                        text: e.text,
                                                    });
                                                }}
                                            >
                                                Open in logs
                                            </button>
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
function ProgressBar(props: {
    readonly value: number;
    readonly max: number;
    readonly tone?: string;
    readonly label?: string;
}): JSX.Element {
    const pct: number = Math.max(0, Math.min(100, (props.value / Math.max(1, props.max)) * 100));
    return (
        <svg
            class={`bar${props.tone === undefined ? '' : ` ${props.tone}`}`}
            viewBox="0 0 100 8"
            preserveAspectRatio="none"
            role="progressbar"
            aria-label={props.label ?? 'Listings scored'}
            aria-valuemin={0}
            aria-valuemax={props.max}
            aria-valuenow={props.value}
        >
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
                <span class="num">
                    {p.scored} of ~{p.expected} listings scored · band {Math.max(p.bandIndex, 1)} of {p.bands}
                </span>
            </div>
            <ProgressBar value={p.scored} max={p.expected} />
            <h2 class="spaced">Found so far</h2>
            <p class="hint">Passing the floors and gaining at least +{h.minGainPct}%, best first. Buy quickly: listings move.</p>
            <GainKey header={h} />
            <ItemList header={h} items={finds} scope="live" empty="Nothing yet: good finds appear here as PoB scores them." />
            {filtered.total > 0 && (
                <p class="muted small">
                    Filtered out so far: {filtered.total} · {filtered.sideGrade} under +{h.minGainPct}% · {filtered.floor} break a floor
                </p>
            )}
        </div>
    );
}

/** The top of each price point, whether or not it cleared the minimum gain. */
function BestPerBand(props: {
    readonly header: RunHeader;
    readonly items: readonly UiItem[];
    readonly tags: ReadonlyMap<string, string>;
}): JSX.Element {
    const rows: BandBest[] = bestPerBand(props.items, props.header.bands);
    return (
        <div class="card">
            <h2>Best per band</h2>
            <table class="band-best">
                <thead>
                    <tr>
                        <th>Band</th>
                        <th>Best that passes the floors</th>
                        <th class="num">Overall</th>
                        <th class="num">Price</th>
                        <th class="num">Worth a look</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r: BandBest) => (
                        <tr key={r.band.id}>
                            <td>{r.band.label}</td>
                            {r.best === null ? (
                                <td class="muted" colSpan={3}>
                                    {r.scored === 0 ? 'Nothing scored' : 'Nothing passed the floors'}
                                </td>
                            ) : (
                                <>
                                    <td>
                                        {r.best.name || r.best.baseType}
                                        {props.tags.has(r.best.id) && <span class="tag">{props.tags.get(r.best.id)}</span>}
                                    </td>
                                    <td
                                        class={`num ${r.best.gainPct !== null && r.best.gainPct >= props.header.minGainPct ? 'pass' : 'muted'}`}
                                    >
                                        {gainText(r.best.gainPct)}
                                    </td>
                                    <td class="num">
                                        {r.best.price === null ? (
                                            'no price'
                                        ) : (
                                            <Orb currency={r.best.price.currency} amount={r.best.price.amount} />
                                        )}
                                    </td>
                                </>
                            )}
                            <td class="num">
                                {r.worth} of {r.scored}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
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
    const listed: UiItem[] =
        group === 'shown'
            ? shown
            : group === 'all'
              ? [...summary.items].sort(byGain)
              : summary.items.filter((i: UiItem) => i.hidden === group).sort(byGain);
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
                    <div class="kpi">
                        <span class="kpi-value num">{c.scored}</span>
                        <span class="kpi-label">scored by PoB</span>
                    </div>
                    <div class="kpi">
                        <span class={`kpi-value num${shown.length > 0 ? ' pass' : ''}`}>{shown.length}</span>
                        <span class="kpi-label">worth a look</span>
                    </div>
                    <div class="kpi">
                        <span class={`kpi-value num ${tone(best?.gainPct ?? null)}`}>
                            {best?.gainPct === null || best === undefined ? '–' : gainText(best.gainPct)}
                        </span>
                        <span class="kpi-label">best gain in budget</span>
                    </div>
                    <div class="kpi">
                        <span class="kpi-value num">{c.searches}</span>
                        <span class="kpi-label">searches · {c.fetched} fetched</span>
                    </div>
                    <div class="kpi">
                        <span class="kpi-value num">{Math.round(summary.seconds)} s</span>
                        <span class="kpi-label">run time</span>
                    </div>
                </div>
                {(c.failed > 0 || c.missing > 0) && (
                    <p class="small">
                        {c.failed > 0 && <span class="warn">{c.failed} PoB couldn't score. </span>}
                        {c.missing > 0 && <span class="muted">{c.missing} gone before the fetch.</span>}
                    </p>
                )}
                <div class="groups" role="tablist" aria-label="Which items">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={group === 'shown'}
                        class={group === 'shown' ? 'chip on' : 'chip'}
                        onClick={() => {
                            setGroup('shown');
                        }}
                    >
                        Worth a look ({shown.length})
                    </button>
                    {HIDDEN_REASONS.filter((r: HiddenReason) => (counts.get(r) ?? 0) > 0).map((r: HiddenReason) => (
                        <button
                            key={r}
                            type="button"
                            role="tab"
                            aria-selected={group === r}
                            class={group === r ? 'chip on' : 'chip'}
                            onClick={() => {
                                setGroup(r);
                            }}
                        >
                            {counts.get(r)} {HIDDEN_LABELS[r]}
                        </button>
                    ))}
                    <button
                        type="button"
                        role="tab"
                        aria-selected={group === 'all'}
                        class={group === 'all' ? 'chip on' : 'chip'}
                        onClick={() => {
                            setGroup('all');
                        }}
                    >
                        All ({summary.items.length})
                    </button>
                </div>
                <ItemList
                    header={h}
                    items={listed}
                    tags={tags}
                    scope="list"
                    empty={
                        group === 'shown'
                            ? 'Nothing cleared the floors and the minimum gain. The groups above show what was filtered out and why.'
                            : 'Nothing in this group.'
                    }
                />
            </div>
        </>
    );
}

export function RunView(): JSX.Element {
    const snap: RunSnapshot | null = run.value;
    if (snap === null) {
        return (
            <section class="page">
                <header class="page-head">
                    <h1>Run</h1>
                </header>
                <div class="card empty">
                    <p>No run yet.</p>
                    <button
                        type="button"
                        class="btn"
                        onClick={() => {
                            go('search');
                        }}
                    >
                        Go to Search
                    </button>
                </div>
            </section>
        );
    }
    const h: RunHeader = snap.header;
    const live: boolean = isLive(snap.phase);
    const finds: number = goodFinds(snap.items, h.minGainPct).length;
    const title: string =
        snap.phase === 'paused'
            ? `Paused · ${finds} good find${finds === 1 ? '' : 's'} so far`
            : live
              ? `Searching… ${finds} good find${finds === 1 ? '' : 's'} so far`
              : snap.phase === 'cancelled'
                ? 'Cancelled'
                : snap.phase === 'failed'
                  ? 'The run failed'
                  : 'Results';
    return (
        <section class="page wide">
            <header class="page-head run-head">
                <div>
                    <p class="crumbs muted">
                        {h.buildName} / {h.slot}, max {h.budgetLabel} / {h.targetLabel} · baseline {compact(h.baselineDamage)} DPS
                        {h.baselineEhp !== null ? `, ${compact(h.baselineEhp)} EHP` : ''} · now:{' '}
                        {slotWasEmpty(h) ? 'empty slot' : h.currentItem}
                    </p>
                    <h1>{title}</h1>
                    {deepening.value.error !== null && !live && <p class="fail small">{deepening.value.error}</p>}
                </div>
                <div class="actions">
                    {snap.phase === 'searching' && (
                        <button type="button" class="btn" onClick={pauseRun}>
                            Pause
                        </button>
                    )}
                    {snap.phase === 'paused' && (
                        <button type="button" class="btn primary" onClick={resumeRun}>
                            Resume
                        </button>
                    )}
                    {live && (
                        <button type="button" class="btn" onClick={cancelRun}>
                            Cancel
                        </button>
                    )}
                    {snap.phase === 'done' && snap.summary !== null && h.depth !== 'thorough' && (
                        <button
                            type="button"
                            class="btn primary"
                            disabled={deepening.value.busy}
                            title="Score more of the same searches' listings (Thorough, 100 per band). No new searches."
                            onClick={() => void deepenRun(h.runId)}
                        >
                            {deepening.value.busy ? 'Starting…' : 'Search deeper'}
                        </button>
                    )}
                    {!live && deepening.value.busy && (
                        <button type="button" class="btn" onClick={cancelRun}>
                            Cancel
                        </button>
                    )}
                    {!live && (
                        <button
                            type="button"
                            class="btn"
                            onClick={() => {
                                go('search');
                            }}
                        >
                            New search
                        </button>
                    )}
                </div>
            </header>
            <LimitsStrip />
            <div class="run-grid">
                <div class="run-main">{snap.summary === null ? <Live snap={snap} /> : <Done snap={snap} summary={snap.summary} />}</div>
                <aside class="run-side">
                    <NowEquipped header={h} />
                    <Bands snap={snap} />
                    <SearchedFor header={h} />
                    <Feed feed={snap.feed} runId={h.runId} />
                </aside>
            </div>
        </section>
    );
}
