// "What it will search for" on the Search view (PLAN.md, "Review PoB's weights before searching"): PoB's
// weighted stats for the chosen slot, heaviest first, each one switchable off or reweighted before the search.
// Only the search ranking changes; PoB still scores every listing against the real build, so gains stay honest.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, TargetedEvent, TargetedKeyboardEvent } from 'preact';
import type { PrunedStat, SearchedStat, WeightPreview } from '@poe-upgrade-finder/ipc';
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
import { isOn, percentOfTop, shownPercent, topWeight, weightCounts, withOn, withPercent } from '@poe-upgrade-finder/vocab';
import type { GearSlot, WeightCounts, WeightEdit, WeightEdits } from '@poe-upgrade-finder/vocab';

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
    readonly edit: WeightEdit | undefined;
    /** Taken out by the slot plan: not searched, whatever its edit says. */
    readonly pruned: PrunedStat | undefined;
}): JSX.Element {
    const { stat, top, edit, pruned } = props;
    const on: boolean = pruned === undefined && isOn(edit);
    const pct: number = shownPercent(stat.weight, edit, top);
    const [text, setText] = useState<string>(String(pct));
    const [refused, setRefused] = useState<boolean>(false);
    useEffect(() => {
        setText(String(pct));
    }, [pct]);
    /** Reads the box itself, not the last render's text: an input and a change in one tick would see the old text. */
    const commit = (typed: string): void => {
        const next: WeightEdit | undefined | 'refused' = withPercent(edit, Number(typed), stat.weight, top);
        if (next === 'refused') {
            // Said on screen, not dropped silently (#111): the box takes a % above 0; off is the tick box.
            setText(String(pct));
            setRefused(true);
            return;
        }
        setRefused(false);
        if (next !== edit) {
            setWeightEdit(props.slot, stat.statId, next);
        }
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
                        setWeightEdit(props.slot, stat.statId, withOn(edit, e.currentTarget.checked));
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
                        aria-invalid={refused}
                        title={refused ? 'Type a % above 0. To leave the stat out, untick it.' : undefined}
                        disabled={!on}
                        value={text}
                        onInput={(e: TargetedEvent<HTMLInputElement>) => {
                            setText(e.currentTarget.value);
                            setRefused(false);
                        }}
                        onChange={(e: TargetedEvent<HTMLInputElement>) => {
                            commit(e.currentTarget.value);
                        }}
                        onKeyDown={(e: TargetedKeyboardEvent<HTMLInputElement>) => {
                            if (e.key === 'Enter') {
                                commit(e.currentTarget.value);
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
                    title={`Back to PoB's ${percentOfTop(stat.weight, top)}%, on`}
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
    const edits: WeightEdits = editsFor(props.slot);
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
    const top: number = topWeight(ready?.weights ?? []);
    const counts: WeightCounts = weightCounts(weights, edits, new Set<string>(pruned.keys()));
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
                        {counts.on} of {counts.searchable} stats on
                        {counts.reweighted > 0 ? ` · ${counts.reweighted} reweighted` : ''}
                        {pruned.size > 0 ? ` · ${pruned.size} taken out by the plan` : ''}
                        {Object.keys(edits).length > 0 && (
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
