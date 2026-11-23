// The Logs card in Settings (PLAN.md, Logging, "Using it"): today's recent lines with level and area filters,
// a line's data one click away, and Export logs (today's log plus the last run's, redacted, as a zip).
// A warning or error in the Run view's feed opens it here: filtered to that run and level, scrolled to the
// line, which is opened and highlighted (state/log-focus.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, RefObject, TargetedEvent } from 'preact';
import type { LogsView, RunSnapshot, UiLogLevel, UiLogLine } from '@poe-upgrade-finder/ipc';
import { UI_LOG_LEVELS } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { findFocusLine } from '../log-focus.ts';
import type { LogFocus } from '../log-focus.ts';
import { logFocus } from '../state/log-focus.ts';
import { run } from '../state/run.ts';
import { messageOf } from '@poe-upgrade-finder/validate';

const LIMIT: number = 300;
const LEVEL_LABEL: Readonly<Record<UiLogLevel, string>> = {
    debug: 'Everything',
    info: 'Info and up',
    warn: 'Warnings and errors',
    error: 'Errors only',
};

function time(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

function LogRow(props: { readonly line: UiLogLine; readonly focused: boolean }): JSX.Element {
    const [open, setOpen] = useState<boolean>(props.focused);
    const ref: RefObject<HTMLLIElement | null> = useRef<HTMLLIElement>(null);
    const l: UiLogLine = props.line;
    useEffect(() => {
        if (props.focused) {
            setOpen(true);
            ref.current?.scrollIntoView({ block: 'center' });
        }
    }, [props.focused]);
    return (
        <li ref={ref} class={`log-line ${l.level}${props.focused ? ' focused' : ''}`}>
            <button
                type="button"
                class="log-head"
                aria-expanded={open}
                disabled={l.data === null}
                onClick={() => {
                    setOpen(!open);
                }}
            >
                <span class="num muted">{time(l.t)}</span>
                <span class={`log-level ${l.level}`}>{l.level.toUpperCase()}</span>
                <span class="muted">{l.area}</span>
                <span class="log-msg">{l.msg}</span>
            </button>
            {open && l.data !== null && <pre class="itemtext">{l.data}</pre>}
        </li>
    );
}

interface Filters {
    readonly minLevel: UiLogLevel;
    readonly area: string | null;
    readonly runId: string | null;
}

export function LogsCard(): JSX.Element {
    // A focus from the Run view is read once, on the way in.
    const [focus] = useState<LogFocus | null>(() => {
        const f: LogFocus | null = logFocus.value;
        logFocus.value = null;
        return f;
    });
    const [filters, setFilters] = useState<Filters>(
        focus === null ? { minLevel: 'info', area: null, runId: null } : { minLevel: focus.level, area: null, runId: focus.runId },
    );
    const [view, setView] = useState<LogsView | null>(null);
    const [focusIndex, setFocusIndex] = useState<number>(-1);
    const [error, setError] = useState<string | null>(null);
    const [exportMsg, setExportMsg] = useState<string | null>(null);
    const cardRef: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement>(null);
    const snap: RunSnapshot | null = run.value;

    const load = async (): Promise<void> => {
        try {
            const v: LogsView = await call('logs.recent', { ...filters, limit: LIMIT });
            setView(v);
            setFocusIndex(focus === null ? -1 : findFocusLine(v.lines, focus));
            setError(null);
        } catch (e: unknown) {
            setError(messageOf(e));
        }
    };
    useEffect(() => {
        void load();
    }, [filters]);
    useEffect(() => {
        if (focus !== null) {
            cardRef.current?.scrollIntoView({ block: 'start' });
        }
    }, []);

    const exportLogs = async (): Promise<void> => {
        setExportMsg('Choose where to save…');
        try {
            const r = await call('logs.export', { runId: snap?.header.runId ?? null });
            setExportMsg(r.saved ? `Saved ${r.file ?? ''}` : null);
        } catch (e: unknown) {
            setExportMsg(messageOf(e));
        }
    };

    return (
        <div class="card" ref={cardRef}>
            <h2>Logs</h2>
            <div class="log-filters">
                <label>
                    <span class="muted small">Show</span>
                    <select
                        value={filters.minLevel}
                        onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                            const v: string = e.currentTarget.value;
                            const level: UiLogLevel | undefined = UI_LOG_LEVELS.find((x: UiLogLevel) => x === v);
                            if (level !== undefined) {
                                setFilters({ ...filters, minLevel: level });
                            }
                        }}
                    >
                        {UI_LOG_LEVELS.map((l: UiLogLevel) => (
                            <option key={l} value={l}>
                                {LEVEL_LABEL[l]}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    <span class="muted small">Area</span>
                    <select
                        value={filters.area ?? ''}
                        onChange={(e: TargetedEvent<HTMLSelectElement>) => {
                            setFilters({ ...filters, area: e.currentTarget.value === '' ? null : e.currentTarget.value });
                        }}
                    >
                        <option value="">All</option>
                        {(view?.areas ?? []).map((a: string) => (
                            <option key={a} value={a}>
                                {a}
                            </option>
                        ))}
                    </select>
                </label>
                <button type="button" class="btn" onClick={() => void load()}>
                    Refresh
                </button>
                <button type="button" class="btn" onClick={() => void exportLogs()}>
                    Export logs
                </button>
            </div>
            {filters.runId !== null && (
                <p class="small">
                    Only the run {filters.runId}.{' '}
                    <button
                        type="button"
                        class="link"
                        onClick={() => {
                            setFilters({ ...filters, runId: null });
                        }}
                    >
                        Show all runs
                    </button>
                </p>
            )}
            {focus !== null && view !== null && focusIndex < 0 && (
                <p class="warn small">That line isn't in today's log (it may be from before midnight, or more than {LIMIT} lines back).</p>
            )}
            <p class="hint">
                Today's log, newest first (the last {LIMIT} lines that match). Export logs saves today's log
                {snap !== null ? " and the last run's" : ''} as a zip, checked again for anything private, to send when something goes
                wrong.
            </p>
            {exportMsg !== null && <p class="muted small">{exportMsg}</p>}
            {error !== null && <p class="fail">{error}</p>}
            {view !== null && view.lines.length === 0 && <p class="muted">No lines match.</p>}
            {view !== null && view.lines.length > 0 && (
                <ul class="log-list">
                    {view.lines.map((l: UiLogLine, i: number) => (
                        <LogRow key={`${l.t}-${i}`} line={l} focused={i === focusIndex} />
                    ))}
                </ul>
            )}
        </div>
    );
}
