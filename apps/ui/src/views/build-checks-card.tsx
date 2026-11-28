// The build's gain blend, minimum gain, floors, targets and flags (PLAN.md, Scoring), on the Search view so they're
// easy to change before a run (issue #28; they were on Settings). Saved per build (characters/<build>.json), on
// their own after a short pause.

import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { JSX, TargetedEvent } from 'preact';
import type { BuildSettings } from '@poe-upgrade-finder/ipc';
import { parseNumberText, setBool, setMaxResMin, setNumber, setTargetMaxRes, setTargetNumber } from '../floors-form.ts';
import type { BoolFloor } from '../floors-form.ts';
import { updateBuildSettings } from '../state/builds.ts';
import { messageOf } from '@poe-upgrade-finder/validate';
import { ELEMENTS } from '@poe-upgrade-finder/vocab';
import type { Element, FloorSettings } from '@poe-upgrade-finder/vocab';

type SaveState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'saving' }
    | { readonly kind: 'saved' }
    | { readonly kind: 'error'; readonly message: string };

interface NumberRowProps {
    readonly id: string;
    readonly label: string;
    readonly unit: string;
    readonly value: number | undefined;
    /** Used when the row is ticked on. */
    readonly fallback: number;
    readonly onChange: (value: number | undefined) => void;
}

function NumberRow(props: NumberRowProps): JSX.Element {
    const on: boolean = props.value !== undefined;
    const [text, setText] = useState<string>(String(props.value ?? props.fallback));
    useEffect(() => {
        if (props.value !== undefined) {
            setText(String(props.value));
        }
    }, [props.value]);
    const bad: boolean = on && parseNumberText(text) === undefined;
    return (
        <div class="floor-row">
            <label class="floor-label">
                <input
                    type="checkbox"
                    checked={on}
                    onChange={(e: TargetedEvent<HTMLInputElement>) => {
                        props.onChange(e.currentTarget.checked ? (parseNumberText(text) ?? props.fallback) : undefined);
                    }}
                />
                {props.label}
            </label>
            <span class="floor-value">
                <input
                    id={props.id}
                    class="num small"
                    inputMode="decimal"
                    aria-label={`${props.label} value`}
                    aria-invalid={bad}
                    disabled={!on}
                    value={text}
                    onInput={(e: TargetedEvent<HTMLInputElement>) => {
                        const t: string = e.currentTarget.value;
                        setText(t);
                        const n: number | undefined = parseNumberText(t);
                        if (n !== undefined) {
                            props.onChange(n);
                        }
                    }}
                />
                <span class="muted">{props.unit}</span>
            </span>
        </div>
    );
}

function BoolRow(props: {
    readonly label: string;
    readonly floors: FloorSettings;
    readonly key2: BoolFloor;
    readonly onChange: (f: FloorSettings) => void;
}): JSX.Element {
    return (
        <div class="floor-row">
            <label class="floor-label">
                <input
                    type="checkbox"
                    checked={props.floors[props.key2] === true}
                    onChange={(e: TargetedEvent<HTMLInputElement>) => {
                        props.onChange(setBool(props.floors, props.key2, e.currentTarget.checked));
                    }}
                />
                {props.label}
            </label>
        </div>
    );
}

const MAX_RES_DEFAULT: number = 75;

/** "Blend 50% DPS · min gain 1% · 3 floors · 2 targets · 2 flags". */
export function checksSummary(b: BuildSettings): string {
    const f: FloorSettings = b.floors;
    const floors: number =
        (f.chaosResMin !== undefined ? 1 : 0) +
        Object.keys(f.maxResMin ?? {}).length +
        (f.elementalResCapped === true ? 1 : 0) +
        (f.spellBlockMin !== undefined ? 1 : 0) +
        (f.attributesMet === true ? 1 : 0);
    const t = f.targets;
    const targets: number =
        (t?.chaosRes !== undefined ? 1 : 0) + Object.keys(t?.maxRes ?? {}).length + (t?.overcapMin !== undefined ? 1 : 0);
    const flags: number = (f.flagLifeLoss === true ? 1 : 0) + (f.flagNetRegen === true ? 1 : 0);
    const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
    return [
        `blend ${Math.round(b.blend * 100)}% DPS`,
        `min gain ${b.minGainPct}%`,
        n(floors, 'floor'),
        n(targets, 'target'),
        n(flags, 'flag'),
    ].join(' · ');
}

/** Whether the card is open: shared, so the Search options' summary line can open it and jump to it. */
export const checksOpen: Signal<boolean> = signal<boolean>(false);

/** Opens the card and scrolls it into view. */
export function openChecks(): void {
    checksOpen.value = true;
    requestAnimationFrame(() => {
        document.querySelector('.checks-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

/** Saves this long after the last change, so a slider or a typed number doesn't save on every step. */
const SAVE_DELAY_MS: number = 600;

export function BuildChecksCard(props: { readonly buildId: string; readonly saved: BuildSettings }): JSX.Element {
    const [draft, setDraft] = useState<BuildSettings>(props.saved);
    const [state, setState] = useState<SaveState>({ kind: 'idle' });
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    // Only the settings edited here count; slot, budget and target change on the Search view, and saving
    // those must not throw away an unsaved edit here.
    const editable = (b: BuildSettings): string => JSON.stringify({ f: b.floors, b: b.blend, m: b.minGainPct });
    const savedEditable: string = editable(props.saved);
    useEffect(() => {
        setDraft(props.saved);
    }, [savedEditable]);
    const f: FloorSettings = draft.floors;
    const save = async (next: BuildSettings): Promise<void> => {
        setState({ kind: 'saving' });
        try {
            await updateBuildSettings({ floors: next.floors, blend: next.blend, minGainPct: next.minGainPct });
            setState({ kind: 'saved' });
        } catch (error: unknown) {
            setState({ kind: 'error', message: messageOf(error) });
        }
    };
    useEffect(
        () => () => {
            if (timer.current !== undefined) {
                clearTimeout(timer.current);
            }
        },
        [],
    );
    /** Every edit: shown at once, saved after a short pause. */
    const change = (next: BuildSettings): void => {
        setDraft(next);
        if (timer.current !== undefined) {
            clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => {
            timer.current = undefined;
            void save(next);
        }, SAVE_DELAY_MS);
    };
    const setFloors = (floors: FloorSettings): void => {
        change({ ...draft, floors: floors });
    };
    const dpsPct: number = Math.round(draft.blend * 100);
    return (
        <details
            class="card form checks-card"
            open={checksOpen.value}
            onToggle={(e: TargetedEvent<HTMLDetailsElement>) => {
                checksOpen.value = e.currentTarget.open;
            }}
        >
            <summary class="checks-head">
                <h2>Gain, floors and targets</h2>
                <span class="muted small">{checksSummary(draft)}</span>
                <span aria-live="polite" class={`small ${state.kind === 'error' ? 'fail' : 'muted'}`}>
                    {state.kind === 'saving' ? 'Saving…' : state.kind === 'saved' ? 'Saved' : state.kind === 'error' ? state.message : ''}
                </span>
            </summary>
            <p class="hint">
                For this build (
                {props.buildId
                    .split('/')
                    .pop()
                    ?.replace(/\.xml$/i, '')}
                ). Changes save on their own.
            </p>
            <div class="row">
                <div class="field grow">
                    <label for="blend">
                        Gain blend: {dpsPct}% DPS, {100 - dpsPct}% EHP
                    </label>
                    <input
                        id="blend"
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={draft.blend}
                        onInput={(e: TargetedEvent<HTMLInputElement>) => {
                            change({ ...draft, blend: Number(e.currentTarget.value) });
                        }}
                    />
                    <p class="hint">Also steers PoB's search weights.</p>
                </div>
                <div class="field">
                    <label for="min-gain">Minimum gain</label>
                    <span class="floor-value">
                        <input
                            id="min-gain"
                            class="num small"
                            inputMode="decimal"
                            value={String(draft.minGainPct)}
                            onInput={(e: TargetedEvent<HTMLInputElement>) => {
                                const n: number | undefined = parseNumberText(e.currentTarget.value);
                                if (n !== undefined && n >= 0 && n <= 100) {
                                    change({ ...draft, minGainPct: n });
                                }
                            }}
                        />
                        <span class="muted">%</span>
                    </span>
                    <p class="hint">Smaller gains are side-grades.</p>
                </div>
            </div>

            <div class="checks-cols">
                <div class="checks-col">
                    <h3>Floors</h3>
                    <p class="hint">
                        Minimums an item must not break. Going over is fine. A floor the build already misses is skipped, not failed.
                    </p>
                    <NumberRow
                        id="chaos-min"
                        label="Chaos resistance at least"
                        unit="%"
                        value={f.chaosResMin}
                        fallback={50}
                        onChange={(v) => {
                            setFloors(setNumber(f, 'chaosResMin', v));
                        }}
                    />
                    {ELEMENTS.map((el: Element) => (
                        <NumberRow
                            key={el}
                            id={`max-${el}`}
                            label={`Max ${el.toLowerCase()} resistance at least`}
                            unit="%"
                            value={f.maxResMin?.[el]}
                            fallback={MAX_RES_DEFAULT}
                            onChange={(v) => {
                                setFloors(setMaxResMin(f, el, v));
                            }}
                        />
                    ))}
                    <BoolRow label="Elemental resistances stay capped" floors={f} key2="elementalResCapped" onChange={setFloors} />
                    <NumberRow
                        id="spell-block"
                        label="Spell block at least"
                        unit="%"
                        value={f.spellBlockMin}
                        fallback={75}
                        onChange={(v) => {
                            setFloors(setNumber(f, 'spellBlockMin', v));
                        }}
                    />
                    <BoolRow label="Attribute requirements stay met" floors={f} key2="attributesMet" onChange={setFloors} />
                </div>
                <div class="checks-col">
                    <h3>Targets</h3>
                    <p class="hint">Never filter: an item that ends below one gets a badge.</p>
                    <NumberRow
                        id="t-chaos"
                        label="Chaos resistance"
                        unit="%"
                        value={f.targets?.chaosRes}
                        fallback={75}
                        onChange={(v) => {
                            setFloors(setTargetNumber(f, 'chaosRes', v));
                        }}
                    />
                    {ELEMENTS.map((el: Element) => (
                        <NumberRow
                            key={el}
                            id={`t-max-${el}`}
                            label={`Max ${el.toLowerCase()} resistance`}
                            unit="%"
                            value={f.targets?.maxRes?.[el]}
                            fallback={MAX_RES_DEFAULT + 1}
                            onChange={(v) => {
                                setFloors(setTargetMaxRes(f, el, v));
                            }}
                        />
                    ))}
                    <NumberRow
                        id="t-overcap"
                        label="Overcap on each element"
                        unit="%"
                        value={f.targets?.overcapMin}
                        fallback={10}
                        onChange={(v) => {
                            setFloors(setTargetNumber(f, 'overcapMin', v));
                        }}
                    />

                    <h3>Flags</h3>
                    <BoolRow label="Flag life loss (not on weapons)" floors={f} key2="flagLifeLoss" onChange={setFloors} />
                    <BoolRow
                        label="Flag net life regen turning negative (builds with a degen)"
                        floors={f}
                        key2="flagNetRegen"
                        onChange={setFloors}
                    />
                </div>
            </div>
        </details>
    );
}
