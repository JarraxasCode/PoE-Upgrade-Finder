// The Search view (PLAN.md, UI): build (reloads on save), slot, damage target, budget, search depth, listing
// type, one button; underneath, the PoB baseline line and warnings. Runs start in the next slice.

import type { JSX, TargetedEvent } from 'preact';
import { GEAR_SLOTS, parseBudgetText } from '@poe-upgrade-finder/ipc';
import type { AppSettings, BuildEntry, BuildSettings, BuildState, BuildsList, BuildSummary, EquippedInfo, GearSlot, ListingType, SearchDepth } from '@poe-upgrade-finder/ipc';
import { ago, buildLabel, compact, grouped } from '../format.ts';
import { go } from '../router.ts';
import { buildSettings, buildsList, buildState, rememberForBuild, selectBuild, selectedBuildId, setSlot, setTarget } from '../state/builds.ts';
import { readyValue } from '../state/loadable.ts';
import { budgetText, depthChoice, listingChoice, minBudgetText } from '../state/search-form.ts';
import { appSettings } from '../state/settings.ts';
import { isLive } from '../run-model.ts';
import { cancelRun, run, startRun, starting } from '../state/run.ts';
import { openSignIn, signIn } from '../state/trade.ts';
import { HoverItem, ItemImage } from './item-card.tsx';
import { LimitsStrip } from './limits.tsx';
import { WeightReview } from './weight-review.tsx';
import { weightPreview } from '../state/weights.ts';
import { RateLine, SignInLine, TradeError } from './trade-status.tsx';

const DEPTH_LABELS: Readonly<Record<SearchDepth, string>> = { thorough: 'Thorough (100 per band)', normal: 'Normal (50)', quick: 'Quick (20)' };

function BuildPicker(props: { readonly list: BuildsList }): JSX.Element {
    const folders: Map<string, BuildEntry[]> = new Map<string, BuildEntry[]>();
    for (const b of [...props.list.builds].sort((x: BuildEntry, y: BuildEntry) => x.id.localeCompare(y.id))) {
        const group: BuildEntry[] = folders.get(b.folder) ?? [];
        group.push(b);
        folders.set(b.folder, group);
    }
    const now: number = Date.now();
    const option = (b: BuildEntry): JSX.Element => (
        <option key={b.id} value={b.id}>{`${buildLabel(b)} · saved ${ago(b.modifiedMs, now)}`}</option>
    );
    return (
        <div class="field">
            <label for="build">Build</label>
            <select
                id="build"
                value={selectedBuildId.value ?? ''}
                onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                    void selectBuild(e.currentTarget.value);
                }}
            >
                {selectedBuildId.value === null && <option value="">Choose a build</option>}
                {[...folders.entries()].map(([folder, builds]: [string, BuildEntry[]]) =>
                    folder === '' ? builds.map(option) : <optgroup key={folder} label={folder}>{builds.map(option)}</optgroup>,
                )}
            </select>
            <p class="hint">From {props.list.dir ?? 'PoB'}. Reloads automatically when you save in PoB.</p>
        </div>
    );
}

/** The chosen slot and what is in it now. */
function SelectedSlot(props: { readonly slot: GearSlot | null; readonly equipped: readonly EquippedInfo[] }): JSX.Element {
    if (props.slot === null) {
        return <div class="selected-slot muted">No slot chosen yet.</div>;
    }
    const item: EquippedInfo | undefined = props.equipped.find((e: EquippedInfo) => e.slot === props.slot);
    const v = item?.view ?? null;
    return (
        <div class="selected-slot">
            <span class="muted small">Upgrading</span>
            <span class="selected-name">{props.slot}</span>
            <span class="muted small">Now in PoB</span>
            {item === undefined ? <span class="muted">Nothing equipped</span> : (
                <>
                    <span class={`now-name r-${v?.rarity ?? 'none'}`}>{v?.name || item.name || item.base}</span>
                    {v !== null && v.name !== '' && <span class="muted small">{v.typeLine}</span>}
                </>
            )}
        </div>
    );
}

/** The slot's place in the in-game gear layout (styles.css, "Gear layout"). */
function slotClass(s: GearSlot): string {
    return `gs-${s.toLowerCase().replace(/ /g, '-')}`;
}

function SlotPicker(props: { readonly slot: GearSlot | null; readonly equipped: readonly EquippedInfo[] }): JSX.Element {
    return (
        <div class="field">
            <span class="label" id="slot-label">Slot</span>
            <div class="gear-wrap">
            <div class="gear" role="radiogroup" aria-labelledby="slot-label">
                {GEAR_SLOTS.map((s: GearSlot) => {
                    const item: EquippedInfo | undefined = props.equipped.find((e: EquippedInfo) => e.slot === s);
                    const on: boolean = props.slot === s;
                    return (
                        <HoverItem key={s} tipKey={`slot:${s}`} view={item?.view ?? null} class={`gear-cell ${slotClass(s)}`}>
                            <button
                                type="button"
                                role="radio"
                                aria-checked={on}
                                aria-label={`${s}: ${item === undefined ? 'empty in PoB' : item.name || item.base}`}
                                class={`gear-slot${on ? ' on' : ''}${item === undefined ? ' empty' : ''} r-${item?.view?.rarity ?? 'none'}`}
                                onClick={() => {
                                    setSlot(s);
                                }}
                            >
                                {item?.view !== null && item?.view !== undefined && item.view.icon !== null
                                    ? <ItemImage view={item.view} size="slot" />
                                    : <span class="gear-name">{s}</span>}
                            </button>
                        </HoverItem>
                    );
                })}
            </div>
            <SelectedSlot slot={props.slot} equipped={props.equipped} />
            </div>
            <p class="hint">Click the slot to upgrade. Hover an item for its details.</p>
        </div>
    );
}

function TargetPicker(props: { readonly summary: BuildSummary | undefined; readonly settings: BuildSettings }): JSX.Element {
    const s: BuildSummary | undefined = props.summary;
    return (
        <div class="field">
            <label for="target">Measure damage on</label>
            <select
                id="target"
                disabled={s === undefined}
                value={s?.targetId ?? props.settings.lastTarget ?? 'saved'}
                onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                    void setTarget(e.currentTarget.value);
                }}
            >
                {s === undefined ? <option value="saved">As saved in PoB</option> : s.targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <p class="hint">From your PoB skill groups. Full DPS counts the groups ticked "Include in Full DPS".</p>
        </div>
    );
}

function minBudgetOf(settings: BuildSettings): string {
    return (minBudgetText.value ?? settings.lastMinBudget ?? '').trim();
}

/** Max price, and an optional min price: nothing cheaper is searched (fewer searches; cheap bargains are missed). */
function BudgetInput(props: { readonly settings: BuildSettings }): JSX.Element {
    const value: string = budgetText.value ?? props.settings.lastBudget ?? '';
    const valid: boolean = value.trim() === '' || parseBudgetText(value) !== undefined;
    const min: string = minBudgetText.value ?? props.settings.lastMinBudget ?? '';
    const minValid: boolean = min.trim() === '' || parseBudgetText(min) !== undefined;
    return (
        <div class="row price-range">
        <div class="field">
            <label for="min-budget">Min price <span class="muted">(optional)</span></label>
            <input
                id="min-budget"
                class="budget"
                inputMode="decimal"
                placeholder="none"
                value={min}
                aria-invalid={!minValid}
                aria-describedby="min-budget-hint"
                onInput={(e: TargetedEvent<HTMLInputElement>) => {
                    minBudgetText.value = e.currentTarget.value;
                }}
                onBlur={() => {
                    if (minValid && min.trim() !== (props.settings.lastMinBudget ?? '')) {
                        void rememberForBuild({ lastMinBudget: min.trim() === '' ? null : min.trim() });
                    }
                }}
            />
            <p class={minValid ? 'hint' : 'hint fail'} id="min-budget-hint">
                {minValid ? 'Skip anything cheaper: fewer searches, but no cheap finds.' : 'Type chaos (100c) or divines (1d), or leave it empty.'}
            </p>
        </div>
        <div class="field">
            <label for="budget">Max price</label>
            <input
                id="budget"
                class="budget"
                inputMode="decimal"
                placeholder="300c or 1.5d"
                value={value}
                aria-invalid={!valid}
                aria-describedby="budget-hint"
                onInput={(e: TargetedEvent<HTMLInputElement>) => {
                    budgetText.value = e.currentTarget.value;
                }}
                onBlur={() => {
                    if (valid && value !== props.settings.lastBudget) {
                        void rememberForBuild({ lastBudget: value.trim() === '' ? null : value.trim() });
                    }
                }}
            />
            <p class={valid ? 'hint' : 'hint fail'} id="budget-hint">
                {valid ? 'Chaos (300 or 300c) or divines (1.5d). Searches stay under it, plus one "slightly over budget" band.' : 'Type a number of chaos (300c) or divines (1.5d).'}
            </p>
        </div>
        </div>
    );
}

function Options(props: { readonly settings: AppSettings }): JSX.Element {
    const depth: SearchDepth = depthChoice.value ?? props.settings.depth;
    const listing: ListingType = listingChoice.value ?? props.settings.listing;
    return (
        <div class="row">
            <div class="field">
                <label for="depth">Search depth</label>
                <select
                    id="depth"
                    value={depth}
                    onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                        const v: string = e.currentTarget.value;
                        depthChoice.value = v === 'normal' || v === 'quick' ? v : 'thorough';
                    }}
                >
                    {(['thorough', 'normal', 'quick'] as const).map((d: SearchDepth) => <option key={d} value={d}>{DEPTH_LABELS[d]}</option>)}
                </select>
            </div>
            <div class="field check">
                <label>
                    <input
                        type="checkbox"
                        checked={listing === 'online'}
                        onChange={(e: TargetedEvent<HTMLInputElement>) => {
                            listingChoice.value = e.currentTarget.checked ? 'online' : 'securable';
                        }}
                    />
                    Include whisper listings
                </label>
                <p class="hint">Off: instant buyout only.</p>
            </div>
        </div>
    );
}

function BuildStatus(props: { readonly state: BuildState }): JSX.Element | null {
    const st: BuildState = props.state;
    if (st.kind === 'none') {
        return null;
    }
    if (st.kind === 'loading') {
        return <p class="line muted" aria-live="polite">PoB is loading the build…</p>;
    }
    if (st.kind === 'error') {
        return <p class="line fail" aria-live="polite">PoB couldn't load the build: {st.message}</p>;
    }
    const s: BuildSummary = st.summary;
    return (
        <div class="lines" aria-live="polite">
            <div class="kpis build-kpis">
                <div class="kpi"><span class="kpi-value num">{compact(s.damage)}</span><span class="kpi-label">DPS · {s.targetLabel}</span></div>
                {s.ehp !== null && <div class="kpi"><span class="kpi-value num">{compact(s.ehp)}</span><span class="kpi-label">effective HP</span></div>}
                {s.life !== null && <div class="kpi"><span class="kpi-value num">{grouped(s.life)}</span><span class="kpi-label">life</span></div>}
                <div class="kpi"><span class="kpi-value">{s.ascendClassName ?? s.className ?? '?'}</span><span class="kpi-label">{s.level !== null ? `level ${s.level}` : 'class'} · PoB {s.pobVersion}</span></div>
            </div>
            {s.warnings.map((w: string, i: number) => <p key={i} class="line warn">{w}</p>)}
        </div>
    );
}

interface SearchButtonProps {
    readonly settings: AppSettings;
    readonly perBuild: BuildSettings;
    readonly summary: BuildSummary | undefined;
    readonly slot: GearSlot | null;
}

/** Why the button can't start a run yet, or undefined when it can. */
function blocker(props: SearchButtonProps, budget: string): string | undefined {
    if (props.slot === null) {
        return 'Choose a slot';
    }
    if (parseBudgetText(budget) === undefined) {
        return 'Type a max price';
    }
    const min: string = minBudgetOf(props.perBuild);
    const minParsed = min === '' ? undefined : parseBudgetText(min);
    const maxParsed = parseBudgetText(budget);
    if (min !== '' && minParsed === undefined) {
        return 'Fix the min price';
    }
    if (minParsed !== undefined && maxParsed !== undefined && minParsed.unit === maxParsed.unit && minParsed.amount >= maxParsed.amount) {
        return 'The min price must be under the max';
    }
    if (props.summary === undefined) {
        return 'Waiting for PoB';
    }
    if (!(props.summary.damage > 0)) {
        return 'Pick a damage target';
    }
    if (signIn.value.status !== 'signed-in') {
        return 'Waiting for the sign-in check';
    }
    const wp = weightPreview.value;
    const edits: Readonly<Record<string, number>> = props.perBuild.weightEdits[props.slot] ?? {};
    if (wp.kind === 'ready' && wp.preview.slot === props.slot && wp.preview.weights.length > 0 && wp.preview.weights.every((w) => edits[w.statId] === 0)) {
        return 'Turn at least one stat on';
    }
    if (run.value !== null && isLive(run.value.phase)) {
        return 'A run is going';
    }
    return undefined;
}

function SearchButton(props: SearchButtonProps): JSX.Element {
    const budget: string = (budgetText.value ?? props.perBuild.lastBudget ?? '').trim();
    const state = starting.value;
    if (signIn.value.status === 'signed-out' || signIn.value.status === 'cloudflare') {
        return (
            <div class="actions">
                <button type="button" class="btn primary big" onClick={() => void openSignIn()}>Sign in to search</button>
            </div>
        );
    }
    const why: string | undefined = blocker(props, budget);
    const start = async (): Promise<void> => {
        const id: string | null = selectedBuildId.value;
        if (id === null || props.slot === null || props.summary === undefined) {
            return;
        }
        const header = await startRun({
            buildId: id,
            slot: props.slot,
            budget: budget,
            minBudget: minBudgetOf(props.perBuild),
            target: props.summary.targetId,
            depth: depthChoice.value ?? props.settings.depth,
            listing: listingChoice.value ?? props.settings.listing,
        });
        if (header !== undefined) {
            go('run');
        }
    };
    return (
        <div class="actions column">
            <button type="button" class="btn primary big" disabled={why !== undefined || state.busy} onClick={() => void start()}>
                {state.busy ? 'Preparing: PoB strips the slot and builds the search…' : why ?? `Find upgrades for ${props.slot ?? ''}`}
            </button>
            {state.busy && <button type="button" class="btn" onClick={cancelRun}>Cancel</button>}
            {state.error !== null && <p class="fail" role="alert">{state.error}</p>}
            {run.value !== null && isLive(run.value.phase) && <button type="button" class="link" onClick={() => {
                go('run');
            }}>A run is going: show it</button>}
        </div>
    );
}

export function SearchView(): JSX.Element {
    const list = buildsList.value;
    const settings: AppSettings | undefined = readyValue(appSettings.value);
    const perBuild: BuildSettings | undefined = readyValue(buildSettings.value);
    const state: BuildState = buildState.value;
    const summary: BuildSummary | undefined = state.kind === 'ready' && state.summary.buildId === selectedBuildId.value ? state.summary : undefined;
    // While PoB loads, the gear it reported last time (main's cache), so the images show at once.
    const equipped: readonly EquippedInfo[] = summary?.equipped ?? (state.kind === 'loading' && state.buildId === selectedBuildId.value ? state.equipped ?? [] : []);
    const slot: GearSlot | null = perBuild?.lastSlot ?? null;
    return (
        <section class="page">
            <header class="page-head">
                <h1>Find an upgrade</h1>
                <p class="muted">One slot at a time. Every listing is scored in PoB against your build.</p>
            </header>
            <LimitsStrip />
            {list.kind === 'loading' && <div class="card"><p class="muted">Looking for your PoB builds…</p></div>}
            {list.kind === 'error' && <div class="card"><p class="fail">{list.message}</p></div>}
            {list.kind === 'ready' && list.value.error !== null && (
                <div class="card empty">
                    <p class="warn">{list.value.error}</p>
                    <button type="button" class="btn" onClick={() => {
                        go('settings');
                    }}>Open Settings</button>
                </div>
            )}
            {list.kind === 'ready' && list.value.error === null && list.value.builds.length === 0 && (
                <div class="card"><p class="muted">No PoB builds in {list.value.dir}. Save one in PoB, or choose the folder in Settings.</p></div>
            )}
            {list.kind === 'ready' && list.value.builds.length > 0 && (
                <>
                    <div class="card form">
                        <BuildPicker list={list.value} />
                        <BuildStatus state={state} />
                    </div>
                    {perBuild !== undefined && settings !== undefined && (
                        <div class="search-grid">
                            <div class="card gear-card">
                                <SlotPicker slot={slot} equipped={equipped} />
                            </div>
                            <div class="card form">
                                <TargetPicker summary={summary} settings={perBuild} />
                                <BudgetInput settings={perBuild} />
                                <Options settings={settings} />
                                <SearchButton settings={settings} perBuild={perBuild} summary={summary} slot={slot} />
                                <div class="status">
                                    {signIn.value.status !== 'signed-in' && <SignInLine />}
                                    <RateLine />
                                    <TradeError />
                                </div>
                            </div>
                        </div>
                    )}
                    {perBuild !== undefined && slot !== null && summary !== undefined && selectedBuildId.value !== null && (
                        <WeightReview buildId={selectedBuildId.value} slot={slot} target={summary.targetId} />
                    )}
                </>
            )}
        </section>
    );
}
