// The unique picker on the Search view (#113): the uniques PoB knows for the slot's item type, best estimated
// change first, a search box, and the picked unique's weights (read-only: they come from its own rolls).

import { useEffect, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import type { SearchedStat, UiUnique } from '@poe-upgrade-finder/ipc';
import { uniqueTitle } from '@poe-upgrade-finder/vocab';
import type { GearSlot, PickedUnique } from '@poe-upgrade-finder/vocab';
import { signedPct } from '../format.ts';
import { loadUniqueList, pickUnique, uniqueChoiceFor, uniqueList, uniqueListKey } from '../state/uniques.ts';

const SHOWN: number = 30;

function plainCount(all: readonly UiUnique[]): number {
    return all.filter((u: UiUnique) => u.foulborn === null).length;
}

/** " and 13 Foulborn versions", or nothing when the item type has none (P31). */
function foulbornText(all: readonly UiUnique[]): string {
    const n: number = all.length - plainCount(all);
    return n === 0 ? '' : ` and ${n} Foulborn ${n === 1 ? 'version' : 'versions'}`;
}

function titleOf(u: UiUnique): string {
    return uniqueTitle(u.foulborn === null ? { name: u.name } : { name: u.name, foulborn: u.foulborn });
}

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
    const matching: readonly UiUnique[] =
        q === '' ? all : all.filter((u: UiUnique) => `${titleOf(u)} ${u.base} ${u.foulbornLine ?? ''}`.toLowerCase().includes(q));
    // Several uniques share a name (Doryani's Delusion has three boots), and each Foulborn version is its own pick
    // (P31): a pick is its name, base and mutated mod.
    const isPicked = (u: UiUnique): boolean =>
        picked !== null && picked.name === u.name && picked.base === u.base && (picked.foulborn ?? null) === u.foulborn;
    const chosen: UiUnique | undefined = all.find(isPicked);
    return (
        <div class="card unique-card">
            <h2>Pick a unique</h2>
            <p class="muted small">
                {plainCount(all)} {itemType.toLowerCase()} uniques{foulbornText(all)}, by PoB's estimate of a top-rolled copy against your
                item. The run finds the best-value copies of the one you pick.
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
                    <li key={`${u.name}|${u.base}|${u.foulborn ?? ''}`}>
                        <button
                            type="button"
                            role="option"
                            aria-selected={isPicked(u)}
                            class={`unique-row${isPicked(u) ? ' on' : ''}`}
                            onClick={() => {
                                pickUnique(slot, {
                                    name: u.name,
                                    base: u.base,
                                    tradeType: u.tradeType,
                                    ...(u.foulborn === null ? {} : { foulborn: u.foulborn }),
                                });
                            }}
                        >
                            <span class="r-unique unique-name">{titleOf(u)}</span>
                            <span class="muted small">{u.foulbornLine === null ? u.base : `${u.base} · ${u.foulbornLine}`}</span>
                            <span class={`num ${u.changePct > 0 ? 'pass' : 'muted'}`}>{signedPct(u.changePct)}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {matching.length > SHOWN && <p class="muted small">{matching.length - SHOWN} more: narrow the search.</p>}
            {matching.length === 0 && <p class="muted small">No unique matches that.</p>}
            {chosen !== undefined && (
                <div class="unique-weights">
                    <h3>{titleOf(chosen)}</h3>
                    {chosen.foulbornLine !== null && (
                        <p class="muted small">
                            Foulborn copies only, with {chosen.foulbornLine} in place of the unique's own line. Other Foulborn versions and
                            plain copies are left out.
                        </p>
                    )}
                    <Weights unique={chosen} />
                </div>
            )}
        </div>
    );
}
