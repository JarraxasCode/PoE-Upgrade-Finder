// The unique picker on the Search view (#113): the uniques PoB knows for the slot's item type, best estimated
// change first, a search box, and the picked unique's weights (read-only: they come from its own rolls).

import { useEffect, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import type { SearchedStat, UiUnique } from '@poe-upgrade-finder/ipc';
import type { GearSlot, PickedUnique } from '@poe-upgrade-finder/vocab';
import { signedPct } from '../format.ts';
import { loadUniqueList, pickUnique, uniqueChoiceFor, uniqueList, uniqueListKey } from '../state/uniques.ts';

const SHOWN: number = 30;

interface Props {
    readonly buildId: string;
    readonly slot: GearSlot;
    readonly target: string;
    readonly itemType: string;
}

function Weights(props: { readonly unique: UiUnique }): JSX.Element {
    const u: UiUnique = props.unique;
    if (u.weights.length === 0) {
        return <p class="muted small">None of its rolling lines changes your build, so the cheapest copies are searched first.</p>;
    }
    const top: number = Math.abs(u.weights[0]?.weight ?? 1) || 1;
    return (
        <>
            <p class="muted small">What each rolling line is worth to your build, heaviest first. Copies are ranked by these.</p>
            <ul class="searched">
                {u.weights.map((w: SearchedStat) => (
                    <li key={w.statId} title={w.statId}>
                        <span class="searched-label">{w.label}</span>
                        <span class="num muted">{Math.round((Math.abs(w.weight) / top) * 100)}%</span>
                    </li>
                ))}
            </ul>
        </>
    );
}

export function UniquePicker(props: Props): JSX.Element {
    const { buildId, slot, target, itemType } = props;
    const [query, setQuery] = useState<string>('');
    const key: string = uniqueListKey(buildId, slot, target, itemType);
    useEffect(() => {
        void loadUniqueList(buildId, slot, target, itemType);
    }, [key]);
    const state = uniqueList.value;
    const picked: PickedUnique | null = uniqueChoiceFor(slot)?.unique ?? null;
    if (state.kind !== 'ready' || state.key !== key) {
        return (
            <div class="card unique-card">
                <h2>Pick a unique</h2>
                {state.kind === 'error' && state.key === key ? (
                    <p class="fail">{state.message}</p>
                ) : (
                    <p class="muted">PoB is scoring every {itemType.toLowerCase()} unique in your build…</p>
                )}
            </div>
        );
    }
    const all: readonly UiUnique[] = state.list.uniques;
    const q: string = query.trim().toLowerCase();
    const matching: readonly UiUnique[] = q === '' ? all : all.filter((u: UiUnique) => `${u.name} ${u.base}`.toLowerCase().includes(q));
    // Several uniques share a name (Doryani's Delusion has three boots): a pick is its name and base.
    const isPicked = (u: UiUnique): boolean => picked !== null && picked.name === u.name && picked.base === u.base;
    const chosen: UiUnique | undefined = all.find(isPicked);
    return (
        <div class="card unique-card">
            <h2>Pick a unique</h2>
            <p class="muted small">
                {all.length} {itemType.toLowerCase()} uniques, by PoB's estimate of a top-rolled copy against your item. The run finds the
                best-value copies of the one you pick.
            </p>
            <input
                type="search"
                class="unique-search"
                placeholder="Search by name or base"
                value={query}
                onInput={(e: TargetedEvent<HTMLInputElement>) => {
                    setQuery(e.currentTarget.value);
                }}
            />
            <ul class="unique-list" role="listbox" aria-label={`${itemType} uniques`}>
                {matching.slice(0, SHOWN).map((u: UiUnique) => (
                    <li key={`${u.name}|${u.base}`}>
                        <button
                            type="button"
                            role="option"
                            aria-selected={isPicked(u)}
                            class={`unique-row${isPicked(u) ? ' on' : ''}`}
                            onClick={() => {
                                pickUnique(slot, { name: u.name, base: u.base, tradeType: u.tradeType });
                            }}
                        >
                            <span class="r-unique unique-name">{u.name}</span>
                            <span class="muted small">{u.base}</span>
                            <span class={`num ${u.changePct > 0 ? 'pass' : 'muted'}`}>{signedPct(u.changePct)}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {matching.length > SHOWN && <p class="muted small">{matching.length - SHOWN} more: narrow the search.</p>}
            {matching.length === 0 && <p class="muted small">No unique matches that.</p>}
            {chosen !== undefined && (
                <div class="unique-weights">
                    <h3>{chosen.name}</h3>
                    <Weights unique={chosen} />
                </div>
            )}
        </div>
    );
}
