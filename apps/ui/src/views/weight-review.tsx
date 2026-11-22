// "What it will search for" on the Search view (PLAN.md, "Review PoB's weights before searching"): PoB's
// weighted stats for the chosen slot, heaviest first, each one switchable off or reweighted before the search.
// Only the search ranking changes; PoB still scores every listing against the real build, so gains stay honest.

import { useEffect, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import type { GearSlot, SearchedStat } from '@poe-upgrade-finder/ipc';
import { editsFor, loadWeightPreview, previewKey, resetWeightEdits, setWeightEdit, weightPreview } from '../state/weights.ts';
import { Info } from './item-card.tsx';

const SHOWN: number = 12;

interface Props {
    readonly buildId: string;
    readonly slot: GearSlot;
    readonly target: string;
}

function WeightRow(props: { readonly slot: GearSlot; readonly stat: SearchedStat; readonly top: number; readonly edit: number | undefined }): JSX.Element {
    const { stat, top, edit } = props;
    const on: boolean = edit === undefined || edit > 0;
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
        <li class={`weight-row${on ? '' : ' off'}${changed ? ' changed' : ''}`}>
            <label class="weight-on">
                <input type="checkbox" checked={on} onChange={(e: TargetedEvent<HTMLInputElement>) => {
                    setWeightEdit(props.slot, stat.statId, e.currentTarget.checked ? (edit !== undefined && edit > 0 ? edit : undefined) : 0);
                }} />
                <span class="weight-label" title={stat.statId}>{stat.label}</span>
            </label>
            <svg class="weight-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
                <rect class="track" x="0" y="0" width="100" height="4" rx="2" />
                {on && <rect class="fill" x="0" y="0" width={Math.max(1, Math.min(100, pct))} height="4" rx="2" />}
            </svg>
            <span class="weight-input">
                <input class="num" inputMode="numeric" aria-label={`Weight for ${stat.label}, % of the top stat`} disabled={!on} value={text}
                    onInput={(e: TargetedEvent<HTMLInputElement>) => {
                        setText(e.currentTarget.value);
                    }}
                    onChange={commit}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                            commit();
                        }
                    }} />
                <span class="muted small">%</span>
            </span>
            {changed && (
                <button type="button" class="link small" title={`Back to PoB's ${Math.round((stat.weight / top) * 100)}%`} onClick={() => {
                    setWeightEdit(props.slot, stat.statId, undefined);
                }}>Undo</button>
            )}
        </li>
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
    const ready = st.kind === 'ready' && st.key === key ? st.preview : undefined;
    const weights: readonly SearchedStat[] = ready?.weights ?? [];
    const top: number = weights[0]?.weight ?? 1;
    const offCount: number = weights.filter((w: SearchedStat) => edits[w.statId] === 0).length;
    const changedCount: number = weights.filter((w: SearchedStat) => edits[w.statId] !== undefined && edits[w.statId] !== 0).length;
    const shown: readonly SearchedStat[] = all ? weights : weights.slice(0, SHOWN);
    return (
        <div class="card weight-card">
            <div class="weight-head">
                <h2>
                    <Info tipKey="weights-h" title="What it will search for" lines={[
                        'PoB\'s trade generator weighs each stat by how much it would add to your build in this slot. The trade site ranks listings by the weighted sum, and each band fetches the top of that ranking.',
                        'Untick a stat to stop ranking by it, or change its weight (as a % of the top stat). PoB still scores every listing against your real build, so gains stay honest: this only changes which listings get fetched.',
                        'Fewer stats also leave more room in each search (about 33 weighted stats fit).',
                    ]}>What it will search for</Info>
                </h2>
                {ready !== undefined && (
                    <span class="muted small">
                        {weights.length - offCount} of {weights.length} stats on{changedCount > 0 ? ` · ${changedCount} reweighted` : ''}
                        {(offCount > 0 || changedCount > 0) && <> · <button type="button" class="link" onClick={() => {
                            resetWeightEdits(props.slot);
                        }}>Reset to PoB's</button></>}
                    </span>
                )}
            </div>
            {(st.kind === 'loading' || (st.kind !== 'idle' && st.key !== key)) && <p class="muted">PoB is working out the weights for {props.slot}…</p>}
            {st.kind === 'error' && st.key === key && <p class="fail">{st.message}</p>}
            {ready !== undefined && weights.length === 0 && <p class="muted">PoB found nothing to weigh for this slot.</p>}
            {ready !== undefined && weights.length > 0 && (
                <>
                    <ul class="weight-list">
                        {shown.map((s: SearchedStat) => <WeightRow key={s.statId} slot={props.slot} stat={s} top={top} edit={edits[s.statId]} />)}
                    </ul>
                    {weights.length > SHOWN && (
                        <button type="button" class="btn small-btn" onClick={() => {
                            setAll(!all);
                        }}>{all ? 'Show fewer' : `Show all ${weights.length}`}</button>
                    )}
                </>
            )}
        </div>
    );
}
