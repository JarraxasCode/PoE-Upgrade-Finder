// The app's JSON Lines logger (PLAN.md, Logging).
//
//  - logs/app-YYYY-MM-DD.jsonl: everything, one file per (local) day;
//  - logs/runs/<run id>.jsonl: the same lines for one run only;
//  - kept 14 days or 200 MB, whichever comes first, oldest files deleted first;
//  - one JSON object per line: t (ms), level, area, runId, reqId, msg, data;
//  - debug lines only with the Debug toggle on.
//
// Never logged: cookies, auth headers, passwords, session ids, tokens. Callers already keep these out (the
// trade client only ever sees rate-limit headers); redact() is the second line of defence, by key name and
// by value pattern.

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** What the engine client and the trade client log to (structurally their EngineLogger / TradeLogger). */
export interface Logger {
    log(level: LogLevel, message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface LogLine {
    readonly t: number;
    readonly level: LogLevel;
    readonly area: string;
    readonly runId?: string;
    readonly reqId?: number | string;
    readonly msg: string;
    readonly data?: unknown;
}

export interface JsonlLoggerOptions {
    /** The logs folder (app data's logs/). */
    readonly dir: string;
    readonly debug?: boolean;
    readonly maxDays?: number;
    readonly maxBytes?: number;
    readonly now?: () => number;
    /** Also hand every line to this (e.g. the CLI's console). */
    readonly echo?: (line: LogLine) => void;
}

const DAY_MS: number = 24 * 3600 * 1000;
const REDACTED: string = '[redacted]';
const SECRET_KEY: RegExp = /cookie|authori[sz]ation|password|passwd|poesessid|poetoken|session[-_]?id|token|secret|credential/i;
const SECRET_VALUE: RegExp = /(POESESSID|POETOKEN|cf_clearance)=[^;,\s]+/gi;

/** Removes secrets from a value before it's logged: secret-looking keys and cookie strings. */
export function redact(value: unknown, depth: number = 0): unknown {
    if (depth > 12) {
        return '[too deep]';
    }
    if (typeof value === 'string') {
        return value.replace(SECRET_VALUE, `$1=${REDACTED}`);
    }
    if (Array.isArray(value)) {
        return value.map((v: unknown) => redact(v, depth + 1));
    }
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
        }
        return out;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return String(value); // JSON has no Infinity or NaN
    }
    return value;
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

export function dayStamp(ms: number): string {
    const d: Date = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Run ids become file names: keep them to safe characters. */
export function safeRunId(runId: string): string {
    return runId.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class JsonlLogger {
    private readonly dir: string;
    private readonly runsDir: string;
    private readonly maxDays: number;
    private readonly maxBytes: number;
    private readonly now: () => number;
    private readonly echo: ((line: LogLine) => void) | undefined;
    private debugOn: boolean;
    private currentRun: string | undefined;

    public constructor(options: JsonlLoggerOptions) {
        this.dir = options.dir;
        this.runsDir = join(options.dir, 'runs');
        this.maxDays = options.maxDays ?? 14;
        this.maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
        this.now = options.now ?? Date.now;
        this.echo = options.echo;
        this.debugOn = options.debug ?? false;
        mkdirSync(this.runsDir, { recursive: true });
        this.prune();
    }

    public set debug(on: boolean) {
        this.debugOn = on;
    }

    public get debug(): boolean {
        return this.debugOn;
    }

    public get runId(): string | undefined {
        return this.currentRun;
    }

    /** Lines from now on also go to logs/runs/<runId>.jsonl, until endRun. */
    public startRun(runId: string): void {
        this.currentRun = safeRunId(runId);
    }

    public endRun(): void {
        this.currentRun = undefined;
    }

    /** A logger for one area ("trade", "engine", "run", "signin", "rate", "ui"). */
    public area(area: string): Logger {
        return {
            log: (level: LogLevel, message: string, data?: Readonly<Record<string, unknown>>): void => {
                this.write(level, area, message, data);
            },
        };
    }

    public write(level: LogLevel, area: string, message: string, data?: Readonly<Record<string, unknown>>): void {
        if (level === 'debug' && !this.debugOn) {
            return;
        }
        const t: number = this.now();
        // A request id (trade) or command id (engine) in the data is lifted to the line's own reqId.
        const reqId: unknown = data?.['reqId'] ?? data?.['cmdId'];
        const line: LogLine = {
            t: t,
            level: level,
            area: area,
            ...(this.currentRun === undefined ? {} : { runId: this.currentRun }),
            ...(typeof reqId === 'number' || typeof reqId === 'string' ? { reqId: reqId } : {}),
            msg: String(redact(message)),
            ...(data === undefined ? {} : { data: redact(data) }),
        };
        const text: string = `${JSON.stringify(line)}\n`;
        // A log write never fails the caller's trade or engine call (a file briefly locked by antivirus, a
        // full disk): the line is dropped from that file, and still echoed.
        this.append(join(this.dir, `app-${dayStamp(t)}.jsonl`), text);
        if (this.currentRun !== undefined) {
            this.append(join(this.runsDir, `${this.currentRun}.jsonl`), text);
        }
        this.echo?.(line);
    }

    private append(path: string, text: string): void {
        try {
            appendFileSync(path, text);
        } catch {
            // Dropped: see write().
        }
    }

    /** Deletes log files older than maxDays, then the oldest until the total is under maxBytes. */
    public prune(): void {
        const files: { path: string; mtime: number; size: number }[] = [];
        for (const folder of [this.dir, this.runsDir]) {
            for (const name of readdirSync(folder)) {
                if (!name.endsWith('.jsonl')) {
                    continue;
                }
                const path: string = join(folder, name);
                try {
                    const s = statSync(path);
                    files.push({ path: path, mtime: s.mtimeMs, size: s.size });
                } catch {
                    // Gone or locked (antivirus, an editor): pruning is best effort and must never stop the app.
                }
            }
        }
        const cutoff: number = this.now() - this.maxDays * DAY_MS;
        files.sort((a: { mtime: number }, b: { mtime: number }) => a.mtime - b.mtime);
        let total: number = files.reduce((sum: number, f: { size: number }) => sum + f.size, 0);
        for (const f of files) {
            if (f.mtime < cutoff || total > this.maxBytes) {
                try {
                    unlinkSync(f.path);
                    total -= f.size;
                } catch {
                    // Locked: try again on the next start.
                }
            }
        }
    }
}
