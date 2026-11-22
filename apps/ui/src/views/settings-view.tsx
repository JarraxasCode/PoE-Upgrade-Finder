// The Settings panel (PLAN.md, UI): general settings (settings.json), the chosen build's floors, targets,
// DPS/EHP blend and minimum gain (characters/<build>.json), and About. Each section saves on its own.

import { LogsCard } from './logs-card.tsx';
import { useEffect, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import { ELEMENTS } from '@poe-upgrade-finder/ipc';
import type { AppSettings, BuildSettings, Element, FloorSettings, SearchDepth } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { parseNumberText, setBool, setMaxResMin, setNumber, setTargetMaxRes, setTargetNumber } from '../floors-form.ts';
import type { BoolFloor } from '../floors-form.ts';
import { appInfo, pobUpdate, setPobUpdate } from '../state/app-info.ts';
import { buildSettings, buildsList, loadBuilds, selectedBuildId, updateBuildSettings } from '../state/builds.ts';
import { messageOf, readyValue } from '../state/loadable.ts';
import { appSettings, saveSettings } from '../state/settings.ts';
import { RateLine, SignInLine, TradeError } from './trade-status.tsx';

type SaveState = { readonly kind: 'idle' } | { readonly kind: 'saving' } | { readonly kind: 'saved' } | { readonly kind: 'error'; readonly message: string };

function SaveBar(props: { readonly dirty: boolean; readonly state: SaveState; readonly onSave: () => void; readonly onReset: () => void }): JSX.Element {
    return (
        <div class="savebar">
            <button type="button" class="btn primary" disabled={!props.dirty || props.state.kind === 'saving'} onClick={props.onSave}>Save</button>
            <button type="button" class="btn" disabled={!props.dirty} onClick={props.onReset}>Undo changes</button>
            <span aria-live="polite" class={props.state.kind === 'error' ? 'fail' : 'muted'}>
                {props.state.kind === 'saved' && !props.dirty ? 'Saved' : props.state.kind === 'error' ? props.state.message : ''}
            </span>
        </div>
    );
}

// General ---------------------------------------------------------------------------------------------------

function GeneralSettings(props: { readonly saved: AppSettings }): JSX.Element {
    const [draft, setDraft] = useState<AppSettings>(props.saved);
    const [state, setState] = useState<SaveState>({ kind: 'idle' });
    useEffect(() => {
        setDraft(props.saved);
    }, [props.saved]);
    const dirty: boolean = JSON.stringify(draft) !== JSON.stringify(props.saved);
    const list = readyValue(buildsList.value);
    const save = async (): Promise<void> => {
        setState({ kind: 'saving' });
        try {
            await saveSettings(draft);
            setState({ kind: 'saved' });
            if (draft.buildsDir !== props.saved.buildsDir) {
                await loadBuilds();
            }
        } catch (error: unknown) {
            setState({ kind: 'error', message: messageOf(error) });
        }
    };
    return (
        <div class="card form">
            <h2>General</h2>
            <div class="row">
                <div class="field">
                    <label for="league">Trade league</label>
                    <input id="league" value={draft.league} onInput={(e: TargetedEvent<HTMLInputElement>) => {
                        setDraft({ ...draft, league: e.currentTarget.value });
                    }} />
                    <p class="hint">As the trade site names it, e.g. Covens or Standard.</p>
                </div>
                <div class="field">
                    <label for="default-depth">Default search depth</label>
                    <select id="default-depth" value={draft.depth} onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                        const v: string = e.currentTarget.value;
                        const depth: SearchDepth = v === 'normal' || v === 'quick' ? v : 'thorough';
                        setDraft({ ...draft, depth: depth });
                    }}>
                        <option value="thorough">Thorough (100 per band)</option>
                        <option value="normal">Normal (50)</option>
                        <option value="quick">Quick (20)</option>
                    </select>
                </div>
            </div>
            <div class="field check">
                <label>
                    <input type="checkbox" checked={draft.listing === 'online'} onChange={(e: TargetedEvent<HTMLInputElement>) => {
                        setDraft({ ...draft, listing: e.currentTarget.checked ? 'online' : 'securable' });
                    }} />
                    Include whisper listings by default
                </label>
            </div>
            <div class="field">
                <span class="label">PoB Builds folder</span>
                <p class="path">{list?.dir ?? '…'} <span class="muted">({draft.buildsDir === null ? "PoB's own setting" : 'chosen here'})</span></p>
                <div class="row tight">
                    <button type="button" class="btn" onClick={() => {
                        void call('settings.pickBuildsDir', {}).then((dir: string | null) => {
                            if (dir !== null) {
                                setDraft({ ...draft, buildsDir: dir });
                            }
                        });
                    }}>Choose folder…</button>
                    {draft.buildsDir !== null && <button type="button" class="btn" onClick={() => {
                        setDraft({ ...draft, buildsDir: null });
                    }}>Use PoB's setting</button>}
                </div>
                {draft.buildsDir !== null && draft.buildsDir !== props.saved.buildsDir && <p class="hint">New folder: {draft.buildsDir}</p>}
            </div>
            <div class="field check">
                <label>
                    <input type="checkbox" checked={draft.debug} onChange={(e: TargetedEvent<HTMLInputElement>) => {
                        setDraft({ ...draft, debug: e.currentTarget.checked });
                    }} />
                    Debug lines in the log (from the next start)
                </label>
            </div>
            <SaveBar dirty={dirty} state={state} onSave={() => void save()} onReset={() => {
                setDraft(props.saved);
            }} />
        </div>
    );
}

// Floors ----------------------------------------------------------------------------------------------------

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
                <input type="checkbox" checked={on} onChange={(e: TargetedEvent<HTMLInputElement>) => {
                    props.onChange(e.currentTarget.checked ? parseNumberText(text) ?? props.fallback : undefined);
                }} />
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

function BoolRow(props: { readonly label: string; readonly floors: FloorSettings; readonly key2: BoolFloor; readonly onChange: (f: FloorSettings) => void }): JSX.Element {
    return (
        <div class="floor-row">
            <label class="floor-label">
                <input type="checkbox" checked={props.floors[props.key2] === true} onChange={(e: TargetedEvent<HTMLInputElement>) => {
                    props.onChange(setBool(props.floors, props.key2, e.currentTarget.checked));
                }} />
                {props.label}
            </label>
        </div>
    );
}

const MAX_RES_DEFAULT: number = 75;

function BuildSettingsCard(props: { readonly buildId: string; readonly saved: BuildSettings }): JSX.Element {
    const [draft, setDraft] = useState<BuildSettings>(props.saved);
    const [state, setState] = useState<SaveState>({ kind: 'idle' });
    // Only the settings edited here count; slot, budget and target change on the Search view, and saving
    // those must not throw away an unsaved edit here.
    const editable = (b: BuildSettings): string => JSON.stringify({ f: b.floors, b: b.blend, m: b.minGainPct });
    const savedEditable: string = editable(props.saved);
    useEffect(() => {
        setDraft(props.saved);
    }, [savedEditable]);
    const dirty: boolean = editable(draft) !== editable(props.saved);
    const f: FloorSettings = draft.floors;
    const setFloors = (floors: FloorSettings): void => {
        setDraft({ ...draft, floors: floors });
    };
    const save = async (): Promise<void> => {
        setState({ kind: 'saving' });
        try {
            await updateBuildSettings({ floors: draft.floors, blend: draft.blend, minGainPct: draft.minGainPct });
            setState({ kind: 'saved' });
        } catch (error: unknown) {
            setState({ kind: 'error', message: messageOf(error) });
        }
    };
    const name: string = props.buildId.split('/').pop()?.replace(/\.xml$/i, '') ?? props.buildId;
    const dpsPct: number = Math.round(draft.blend * 100);
    return (
        <div class="card form">
            <h2>This build: {name}</h2>
            <div class="row">
                <div class="field grow">
                    <label for="blend">Gain blend: {dpsPct}% DPS, {100 - dpsPct}% EHP</label>
                    <input id="blend" type="range" min="0" max="1" step="0.05" value={draft.blend} onInput={(e: TargetedEvent<HTMLInputElement>) => {
                        setDraft({ ...draft, blend: Number(e.currentTarget.value) });
                    }} />
                    <p class="hint">Also steers PoB's search weights.</p>
                </div>
                <div class="field">
                    <label for="min-gain">Minimum gain</label>
                    <span class="floor-value">
                        <input id="min-gain" class="num small" inputMode="decimal" value={String(draft.minGainPct)} onInput={(e: TargetedEvent<HTMLInputElement>) => {
                            const n: number | undefined = parseNumberText(e.currentTarget.value);
                            if (n !== undefined && n >= 0 && n <= 100) {
                                setDraft({ ...draft, minGainPct: n });
                            }
                        }} />
                        <span class="muted">%</span>
                    </span>
                    <p class="hint">Smaller gains are side-grades.</p>
                </div>
            </div>

            <h3>Floors</h3>
            <p class="hint">Minimums an item must not break. Going over is fine. A floor the build already misses is skipped, not failed.</p>
            <NumberRow id="chaos-min" label="Chaos resistance at least" unit="%" value={f.chaosResMin} fallback={50} onChange={(v) => {
                setFloors(setNumber(f, 'chaosResMin', v));
            }} />
            {ELEMENTS.map((el: Element) => (
                <NumberRow key={el} id={`max-${el}`} label={`Max ${el.toLowerCase()} resistance at least`} unit="%" value={f.maxResMin?.[el]} fallback={MAX_RES_DEFAULT} onChange={(v) => {
                    setFloors(setMaxResMin(f, el, v));
                }} />
            ))}
            <BoolRow label="Elemental resistances stay capped" floors={f} key2="elementalResCapped" onChange={setFloors} />
            <NumberRow id="spell-block" label="Spell block at least" unit="%" value={f.spellBlockMin} fallback={75} onChange={(v) => {
                setFloors(setNumber(f, 'spellBlockMin', v));
            }} />
            <BoolRow label="Attribute requirements stay met" floors={f} key2="attributesMet" onChange={setFloors} />

            <h3>Targets</h3>
            <p class="hint">Never filter: an item that ends below one gets a badge.</p>
            <NumberRow id="t-chaos" label="Chaos resistance" unit="%" value={f.targets?.chaosRes} fallback={75} onChange={(v) => {
                setFloors(setTargetNumber(f, 'chaosRes', v));
            }} />
            {ELEMENTS.map((el: Element) => (
                <NumberRow key={el} id={`t-max-${el}`} label={`Max ${el.toLowerCase()} resistance`} unit="%" value={f.targets?.maxRes?.[el]} fallback={MAX_RES_DEFAULT + 1} onChange={(v) => {
                    setFloors(setTargetMaxRes(f, el, v));
                }} />
            ))}
            <NumberRow id="t-overcap" label="Overcap on each element" unit="%" value={f.targets?.overcapMin} fallback={10} onChange={(v) => {
                setFloors(setTargetNumber(f, 'overcapMin', v));
            }} />

            <h3>Flags</h3>
            <BoolRow label="Flag life loss (not on weapons)" floors={f} key2="flagLifeLoss" onChange={setFloors} />
            <BoolRow label="Flag net life regen turning negative (builds with a degen)" floors={f} key2="flagNetRegen" onChange={setFloors} />

            <SaveBar dirty={dirty} state={state} onSave={() => void save()} onReset={() => {
                setDraft(props.saved);
            }} />
        </div>
    );
}

// About -----------------------------------------------------------------------------------------------------

function About(): JSX.Element {
    const info = appInfo.value;
    return (
        <div class="card">
            <h2>About</h2>
            {info.kind === 'loading' && <p class="muted">Loading…</p>}
            {info.kind === 'error' && <p class="fail">Couldn't reach the app: {info.message}</p>}
            {info.kind === 'ready' && (
                <dl class="facts">
                    <dt>PoE Upgrade Finder</dt>
                    <dd class="num">{info.value.appVersion}</dd>
                    <dt>Electron</dt>
                    <dd class="num">{info.value.electron}</dd>
                    <dt>Chromium</dt>
                    <dd class="num">{info.value.chromium}</dd>
                    <dt>Node</dt>
                    <dd class="num">{info.value.node}</dd>
                    <dt>Path of Building</dt>
                    <dd class="num">{info.value.pobVersion ?? 'not found'}</dd>
                </dl>
            )}
            <p class="hint">
                Builds are loaded and every item is scored by Path of Building Community (pathofbuilding.community), bundled
                unchanged under its MIT licence. Thanks to its authors and contributors.
            </p>
            <PobUpdateLine />
            <PobLicense />
        </div>
    );
}

function newer(a: string, b: string): boolean {
    const pa: number[] = a.split('.').map(Number);
    const pb: number[] = b.split('.').map(Number);
    for (let i: number = 0; i < Math.max(pa.length, pb.length); i++) {
        const x: number = pa[i] ?? 0;
        const y: number = pb[i] ?? 0;
        if (x !== y) {
            return x > y;
        }
    }
    return false;
}

function PobUpdateLine(): JSX.Element | null {
    const state = pobUpdate.value;
    const [error, setError] = useState<string | null>(null);
    if (state === null) {
        return null;
    }
    const act = (method: 'pob.check' | 'pob.update' | 'pob.rollback'): void => {
        setError(null);
        void call(method, {}).then(setPobUpdate, (e: unknown) => {
            setError(messageOf(e));
        });
    };
    if (state.fixed) {
        return <p class="hint pob-update">This PoB copy was given on the command line, so updates are off.</p>;
    }
    const busy: boolean = state.phase === 'checking' || state.phase === 'updating';
    const available: boolean = state.latest !== null && state.live !== null && newer(state.latest, state.live);
    return (
        <div class="pob-update">
            {state.phase === 'checking' && <p class="muted">Checking for a newer Path of Building…</p>}
            {state.phase === 'updating' && <p class="muted">Updating Path of Building: {state.step ?? 'working'}…</p>}
            {!busy && available && (
                <p>
                    <strong>Path of Building {state.latest} is available.</strong>{' '}
                    <span class="hint">It downloads only the changed files from PoB Community's GitHub, checks them, and tries your build on it before switching.</span>
                </p>
            )}
            {!busy && !available && state.latest !== null && state.phase !== 'failed' && <p class="hint">Path of Building is up to date (latest release {state.latest}).</p>}
            {state.phase === 'failed' && state.message !== null && <p class="fail">{state.message}</p>}
            {state.phase === 'idle' && state.message !== null && <p class="hint">{state.message}</p>}
            {error !== null && <p class="fail">{error}</p>}
            <div class="btn-row">
                {available && <button type="button" class="btn primary" disabled={busy} onClick={() => {
                    act('pob.update');
                }}>Update to {state.latest}</button>}
                <button type="button" class="btn" disabled={busy} onClick={() => {
                    act('pob.check');
                }}>Check for a PoB update</button>
                {state.previous !== null && <button type="button" class="btn" disabled={busy} onClick={() => {
                    act('pob.rollback');
                }}>Go back to {state.previous}</button>}
            </div>
        </div>
    );
}

function PobLicense(): JSX.Element {
    const [text, setText] = useState<string | null | undefined>(undefined);
    const [open, setOpen] = useState<boolean>(false);
    return (
        <div class="pob-license">
            <button type="button" class="link" aria-expanded={open} onClick={() => {
                setOpen(!open);
                if (text === undefined) {
                    void call('app.pobLicense', {}).then((r) => {
                        setText(r.text);
                    }, () => {
                        setText(null);
                    });
                }
            }}>{open ? 'Hide' : 'Show'} Path of Building's licence</button>
            {open && (text === undefined
                ? <p class="muted">Loading…</p>
                : text === null
                    ? <p class="fail">The licence file couldn't be read.</p>
                    : <pre class="license-text">{text}</pre>)}
        </div>
    );
}

function RemoveCard(): JSX.Element {
    const info = appInfo.value;
    const canRemove: boolean = info.kind === 'ready' && info.value.canRemove;
    const [message, setMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState<boolean>(false);
    return (
        <div class="card">
            <h2>Remove from this PC</h2>
            <p class="hint">
                Deletes the app's files, settings, logs, saved runs and pathofexile.com sign-in, then closes the app. Your Path of
                Building builds aren't touched. Afterwards, delete the exe you started it from.
            </p>
            <div class="btn-row">
                <button type="button" class="btn" disabled={!canRemove || busy} onClick={() => {
                    setBusy(true);
                    void call('app.removeFromPc', {}).then((r) => {
                        setMessage(r.message);
                        setBusy(r.removing);
                    }, (error: unknown) => {
                        setMessage(messageOf(error));
                        setBusy(false);
                    });
                }}>{busy ? 'Removing…' : 'Remove from this PC'}</button>
            </div>
            {!canRemove && info.kind === 'ready' && <p class="hint">Only available in the app started from its exe.</p>}
            {message !== null && <p class="fail">{message}</p>}
        </div>
    );
}

export function SettingsView(): JSX.Element {
    const settings = appSettings.value;
    const perBuild: BuildSettings | undefined = readyValue(buildSettings.value);
    const buildId: string | null = selectedBuildId.value;
    return (
        <section class="page">
            <header class="page-head">
                <h1>Settings</h1>
            </header>
            {settings.kind === 'ready' && <GeneralSettings saved={settings.value} />}
            {settings.kind === 'error' && <div class="card"><p class="fail">{settings.message}</p></div>}
            {buildId !== null && perBuild !== undefined ? (
                <BuildSettingsCard key={buildId} buildId={buildId} saved={perBuild} />
            ) : (
                <div class="card"><p class="muted">Choose a build on the Search view to set its floors and blend.</p></div>
            )}
            <div class="card">
                <h2>Trade account and divine rate</h2>
                <div class="lines">
                    <SignInLine showSignOut />
                    <RateLine />
                    <TradeError />
                </div>
                <p class="hint">Sign out logs you out of pathofexile.com (as the site's own Log out does) and forgets the app's session. No window opens.</p>
            </div>
            <LogsCard />
            <About />
            <RemoveCard />
        </section>
    );
}
