// "What it will search for" on the Search view (PLAN.md, "Review PoB's weights before searching"): PoB's
// weighted stats for the chosen slot, heaviest first, each one switchable off or reweighted before the search.
// Only the search ranking changes; PoB still scores every listing against the real build, so gains stay honest.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import type { GearSlot, PrunedStat, SearchedStat, WeightPreview } from '@poe-upgrade-finder/ipc';
import {
    editsFor,
    loadWeightPreview,
    previewBaseKey,
    previewKey,
    resetWeightEdits,
    setWeightEdit,
    weightPreview,
} from '../state/weights.ts';
import { Info } from './item-card.tsx';

const SHOWN: number = 12;

interface Props {
    readonly buildId: string;
    readonly slot: GearSlot;
    readonly target: string;
}

function WeightRow(props: {
    readonly slot: GearSlot;
    readonly stat: SearchedStat;
    readonly top: number;
    readonly edit: number | undefined;
    /** Taken out by the slot plan: not searched, whatever its edit says. */
    readonly pruned: PrunedStat | undefined;
}): JSX.Element {
    const { stat, top, edit, pruned } = props;
    const on: boolean = pruned === undefined && (edit === undefined || edit > 0);
    const weight: number = edit === undefined || edit === 0 ? stat.weight : edit;
    const pct: number = Math.round((weight / top) * 100);
    const [text, setText] = useState<string>(String(pct));
    useEffect(() => {
        setText(String(pct));
    }, [pct]);
    const commit = (): void => {
        const n: number = Number(text);
        if (!Number.isFinite(n) || n <= 0) {
            setText(String(pct));
            return;
        }
        const next: number = (Math.min(n, 1000) / 100) * top;
        setWeightEdit(props.slot, stat.statId, Math.abs(next - stat.weight) < 1e-9 ? undefined : next);
    };
    const changed: boolean = edit !== undefined;
    return (
        <li class={`weight-row${on ? '' : ' off'}${changed ? ' changed' : ''}${pruned === undefined ? '' : ' pruned'}`}>
            <label class="weight-on" title={pruned === undefined ? undefined : `Taken out by the slot plan: ${pruned.text}`}>
                <input
                    type="checkbox"
                    checked={on}
                    disabled={pruned !== undefined}
                    onChange={(e: TargetedEvent<HTMLInputElement>) => {
                        setWeightEdit(
                            props.slot,
                            stat.statId,
                            e.currentTarget.checked ? (edit !== undefined && edit > 0 ? edit : undefined) : 0,
                        );
                    }}
                />
                <span class="weight-label" title={stat.statId}>
                    {stat.label}
                </span>
            </label>
            <svg class="weight-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
                <rect class="track" x="0" y="0" width="100" height="4" rx="2" />
                {on && <rect class="fill" x="0" y="0" width={Math.max(1, Math.min(100, pct))} height="4" rx="2" />}
            </svg>
            {pruned !== undefined ? (
                <span class="weight-pruned muted small">plan</span>
            ) : (
                <span class="weight-input">
                    <input
                        class="num"
                        inputMode="numeric"
                        aria-label={`Weight for ${stat.label}, % of the top stat`}
                        disabled={!on}
                        value={text}
                        onInput={(e: TargetedEvent<HTMLInputElement>) => {
                            setText(e.currentTarget.value);
                        }}
                        onChange={commit}
                        onKeyDown={(e: KeyboardEvent) => {
                            if (e.key === 'Enter') {
                                commit();
                            }
                        }}
                    />
                    <span class="muted small">%</span>
                </span>
            )}
            {changed && pruned === undefined && (
                <button
                    type="button"
                    class="link small"
                    title={`Back to PoB's ${Math.round((stat.weight / top) * 100)}%`}
                    onClick={() => {
                        setWeightEdit(props.slot, stat.statId, undefined);
                    }}
                >
                    Undo
                </button>
            )}
        </li>
    );
}

/** What the slot plan does to the weights: why it can't be searched, or the weights it takes out and why. */
function PlanEffect(props: { readonly preview: WeightPreview }): JSX.Element | null {
    const { pruned, planProblems, planNotes } = props.preview;
    if (pruned.length === 0 && planProblems.length === 0 && planNotes.length === 0) {
        return null;
    }
    return (
        <div class="plan-effect">
            {planProblems.length > 0 && <p class="fail small">The slot plan can't be searched yet: see its problems on the plan.</p>}
            {planNotes.map((n: string) => (
                <p key={n} class="muted small">
                    {n}
                </p>
            ))}
            {pruned.length > 0 && (
                <>
                    <h3 class="small">Taken out by the slot plan ({pruned.length})</h3>
                    <ul class="plan-pruned">
                        {pruned.map((p: PrunedStat) => (
                            <li key={p.statId} class="small">
                                <span>{p.label}</span> <span class="muted">· {p.text}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}

export function WeightReview(props: Props): JSX.Element {
    const key: string = previewKey(props.buildId, props.slot, props.target);
    const [all, setAll] = useState<boolean>(false);
    useEffect(() => {
        void loadWeightPreview(props.buildId, props.slot, props.target);
    }, [key]);
    const st = weightPreview.value;
    const edits: Readonly<Record<string, number>> = editsFor(props.slot);
    // A plan edit reloads the review: the last one for this build, slot and target stays up (dimmed) meanwhile.
    const baseKey: string = previewBaseKey(props.buildId, props.slot, props.target);
    const last = useRef<{ readonly baseKey: string; readonly preview: WeightPreview } | null>(null);
    if (st.kind === 'ready' && st.key === key) {
        last.current = { baseKey: baseKey, preview: st.preview };
    }
    const fresh: boolean = st.kind === 'ready' && st.key === key;
    const ready: WeightPreview | undefined = last.current?.baseKey === baseKey ? last.current.preview : undefined;
    const pruned: ReadonlyMap<string, PrunedStat> = new Map((ready?.pruned ?? []).map((p: PrunedStat) => [p.statId, p]));
    // What's searched first, then what the plan takes out.
    const weights: readonly SearchedStat[] = [...(ready?.weights ?? [])].sort(
        (a: SearchedStat, b: SearchedStat) => Number(pruned.has(a.statId)) - Number(pruned.has(b.statId)),
    );
    const top: number = ready?.weights[0]?.weight ?? 1;
    const searchable: readonly SearchedStat[] = weights.filter((w: SearchedStat) => !pruned.has(w.statId));
    const offCount: number = searchable.filter((w: SearchedStat) => edits[w.statId] === 0).length;
    const changedCount: number = weights.filter((w: SearchedStat) => edits[w.statId] !== undefined && edits[w.statId] !== 0).length;
    const shown: readonly SearchedStat[] = all ? weights : weights.slice(0, SHOWN);
    return (
        <div class={`card weight-card${ready !== undefined && !fresh ? ' stale' : ''}`} aria-busy={!fresh}>
            <div class="weight-head">
                <h2>
                    <Info
                        tipKey="weights-h"
                        title="What it will search for"
                        lines={[
                            "PoB's trade generator weighs each stat by how much it would add to your build in this slot. The trade site ranks listings by the weighted sum, and each band fetches the top of that ranking.",
                            'Untick a stat to stop ranking by it, or change its weight (as a % of the top stat). PoB still scores every listing against your real build, so gains stay honest: this only changes which listings get fetched.',
                            'Fewer stats also leave more room in each search (about 33 weighted stats fit).',
                        ]}
                    >
                        What it will search for
                    </Info>
                </h2>
                {ready !== undefined && (
                    <span class="muted small">
                        {searchable.length - offCount} of {searchable.length} stats on
                        {changedCount > 0 ? ` · ${changedCount} reweighted` : ''}
                        {pruned.size > 0 ? ` · ${pruned.size} taken out by the plan` : ''}
                        {(offCount > 0 || changedCount > 0) && (
                            <>
                                {' '}
                                ·{' '}
                                <button
                                    type="button"
                                    class="link"
                                    onClick={() => {
                                        resetWeightEdits(props.slot);
                                    }}
                                >
                                    Reset to PoB's
                                </button>
                            </>
                        )}
                    </span>
                )}
            </div>
            {ready === undefined && (st.kind === 'loading' || (st.kind !== 'idle' && st.key !== key)) && (
                <p class="muted">PoB is working out the weights for {props.slot}…</p>
            )}
            {st.kind === 'error' && st.key === key && <p class="fail">{st.message}</p>}
            {ready !== undefined && weights.length === 0 && <p class="muted">PoB found nothing to weigh for this slot.</p>}
            {ready !== undefined && weights.length > 0 && (
                <>
                    <ul class="weight-list">
                        {shown.map((s: SearchedStat) => (
                            <WeightRow
                                key={s.statId}
                                slot={props.slot}
                                stat={s}
                                top={top}
                                edit={edits[s.statId]}
                                pruned={pruned.get(s.statId)}
                            />
                        ))}
                    </ul>
                    {weights.length > SHOWN && (
                        <button
                            type="button"
                            class="btn small-btn"
                            onClick={() => {
                                setAll(!all);
                            }}
                        >
                            {all ? 'Show fewer' : `Show all ${weights.length}`}
                        </button>
                    )}
                </>
            )}
            {ready !== undefined && <PlanEffect preview={ready} />}
        </div>
    );
}
