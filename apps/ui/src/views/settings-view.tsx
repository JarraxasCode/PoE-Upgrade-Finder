// The Settings panel (PLAN.md, UI): general settings (settings.json), the trade account, logs and About. The
// build's floors, targets, blend and minimum gain are on the Search view (issue #28, build-checks-card.tsx).

import { LogsCard } from './logs-card.tsx';
import { useEffect, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import type { AppSettings, SearchDepth } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { appInfo, pobUpdate, setPobUpdate } from '../state/app-info.ts';
import { buildsList, loadBuilds } from '../state/builds.ts';
import { readyValue } from '../state/loadable.ts';
import { appSettings, saveSettings } from '../state/settings.ts';
import { RateLine, SignInLine, TradeError } from './trade-status.tsx';
import { messageOf } from '@poe-upgrade-finder/validate';

type SaveState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'saving' }
    | { readonly kind: 'saved' }
    | { readonly kind: 'error'; readonly message: string };

function SaveBar(props: {
    readonly dirty: boolean;
    readonly state: SaveState;
    readonly onSave: () => void;
    readonly onReset: () => void;
}): JSX.Element {
    return (
        <div class="savebar">
            <button type="button" class="btn primary" disabled={!props.dirty || props.state.kind === 'saving'} onClick={props.onSave}>
                Save
            </button>
            <button type="button" class="btn" disabled={!props.dirty} onClick={props.onReset}>
                Undo changes
            </button>
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
                    <input
                        id="league"
                        value={draft.league}
                        onInput={(e: TargetedEvent<HTMLInputElement>) => {
                            setDraft({ ...draft, league: e.currentTarget.value });
                        }}
                    />
                    <p class="hint">As the trade site names it, e.g. Covens or Standard.</p>
                </div>
                <div class="field">
                    <label for="default-depth">Default search depth</label>
                    <select
                        id="default-depth"
                        value={draft.depth}
                        onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                            const v: string = e.currentTarget.value;
                            const depth: SearchDepth = v === 'normal' || v === 'quick' ? v : 'thorough';
                            setDraft({ ...draft, depth: depth });
                        }}
                    >
                        <option value="thorough">Thorough (100 per band)</option>
                        <option value="normal">Normal (50)</option>
                        <option value="quick">Quick (20)</option>
                    </select>
                </div>
            </div>
            <div class="field check">
                <label>
                    <input
                        type="checkbox"
                        checked={draft.listing === 'online'}
                        onChange={(e: TargetedEvent<HTMLInputElement>) => {
                            setDraft({ ...draft, listing: e.currentTarget.checked ? 'online' : 'securable' });
                        }}
                    />
                    Include whisper listings by default
                </label>
            </div>
            <div class="field">
                <span class="label">PoB Builds folder</span>
                <p class="path">
                    {list?.dir ?? '…'} <span class="muted">({draft.buildsDir === null ? "PoB's own setting" : 'chosen here'})</span>
                </p>
                <div class="row tight">
                    <button
                        type="button"
                        class="btn"
                        onClick={() => {
                            void call('settings.pickBuildsDir', {}).then((dir: string | null) => {
                                if (dir !== null) {
                                    setDraft({ ...draft, buildsDir: dir });
                                }
                            });
                        }}
                    >
                        Choose folder…
                    </button>
                    {draft.buildsDir !== null && (
                        <button
                            type="button"
                            class="btn"
                            onClick={() => {
                                setDraft({ ...draft, buildsDir: null });
                            }}
                        >
                            Use PoB's setting
                        </button>
                    )}
                </div>
                {draft.buildsDir !== null && draft.buildsDir !== props.saved.buildsDir && <p class="hint">New folder: {draft.buildsDir}</p>}
            </div>
            <div class="field check">
                <label>
                    <input
                        type="checkbox"
                        checked={draft.debug}
                        onChange={(e: TargetedEvent<HTMLInputElement>) => {
                            setDraft({ ...draft, debug: e.currentTarget.checked });
                        }}
                    />
                    Debug lines in the log (from the next start)
                </label>
            </div>
            <SaveBar
                dirty={dirty}
                state={state}
                onSave={() => void save()}
                onReset={() => {
                    setDraft(props.saved);
                }}
            />
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
                Builds are loaded and every item is scored by Path of Building Community (pathofbuilding.community), bundled unchanged under
                its MIT licence. Thanks to its authors and contributors.
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
                    <span class="hint">
                        It downloads only the changed files from PoB Community's GitHub, checks them, and tries your build on it before
                        switching.
                    </span>
                </p>
            )}
            {!busy && !available && state.latest !== null && state.phase !== 'failed' && (
                <p class="hint">Path of Building is up to date (latest release {state.latest}).</p>
            )}
            {state.phase === 'failed' && state.message !== null && <p class="fail">{state.message}</p>}
            {state.phase === 'idle' && state.message !== null && <p class="hint">{state.message}</p>}
            {error !== null && <p class="fail">{error}</p>}
            <div class="btn-row">
                {available && (
                    <button
                        type="button"
                        class="btn primary"
                        disabled={busy}
                        onClick={() => {
                            act('pob.update');
                        }}
                    >
                        Update to {state.latest}
                    </button>
                )}
                <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    onClick={() => {
                        act('pob.check');
                    }}
                >
                    Check for a PoB update
                </button>
                {state.previous !== null && (
                    <button
                        type="button"
                        class="btn"
                        disabled={busy}
                        onClick={() => {
                            act('pob.rollback');
                        }}
                    >
                        Go back to {state.previous}
                    </button>
                )}
            </div>
        </div>
    );
}

function PobLicense(): JSX.Element {
    const [text, setText] = useState<string | null | undefined>(undefined);
    const [open, setOpen] = useState<boolean>(false);
    return (
        <div class="pob-license">
            <button
                type="button"
                class="link"
                aria-expanded={open}
                onClick={() => {
                    setOpen(!open);
                    if (text === undefined) {
                        void call('app.pobLicense', {}).then(
                            (r) => {
                                setText(r.text);
                            },
                            () => {
                                setText(null);
                            },
                        );
                    }
                }}
            >
                {open ? 'Hide' : 'Show'} Path of Building's licence
            </button>
            {open &&
                (text === undefined ? (
                    <p class="muted">Loading…</p>
                ) : text === null ? (
                    <p class="fail">The licence file couldn't be read.</p>
                ) : (
                    <pre class="license-text">{text}</pre>
                ))}
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
                Deletes the app's files, settings, logs, saved runs and pathofexile.com sign-in, then closes the app. Your Path of Building
                builds aren't touched. Afterwards, delete the exe you started it from.
            </p>
            <div class="btn-row">
                <button
                    type="button"
                    class="btn"
                    disabled={!canRemove || busy}
                    onClick={() => {
                        setBusy(true);
                        void call('app.removeFromPc', {}).then(
                            (r) => {
                                setMessage(r.message);
                                setBusy(r.removing);
                            },
                            (error: unknown) => {
                                setMessage(messageOf(error));
                                setBusy(false);
                            },
                        );
                    }}
                >
                    {busy ? 'Removing…' : 'Remove from this PC'}
                </button>
            </div>
            {!canRemove && info.kind === 'ready' && <p class="hint">Only available in the app started from its exe.</p>}
            {message !== null && <p class="fail">{message}</p>}
        </div>
    );
}

export function SettingsView(): JSX.Element {
    const settings = appSettings.value;
    return (
        <section class="page">
            <header class="page-head">
                <h1>Settings</h1>
            </header>
            {settings.kind === 'ready' && <GeneralSettings saved={settings.value} />}
            {settings.kind === 'error' && (
                <div class="card">
                    <p class="fail">{settings.message}</p>
                </div>
            )}
            <div class="card">
                <h2>This build</h2>
                <p class="muted">The gain blend, minimum gain, floors, targets and flags are on the Search view, under the slot plan.</p>
            </div>
            <div class="card">
                <h2>Trade account and divine rate</h2>
                <div class="lines">
                    <SignInLine showSignOut />
                    <RateLine />
                    <TradeError />
                </div>
                <p class="hint">
                    Sign out logs you out of pathofexile.com (as the site's own Log out does) and forgets the app's session. No window
                    opens.
                </p>
            </div>
            <LogsCard />
            <About />
            <RemoveCard />
        </section>
    );
}
