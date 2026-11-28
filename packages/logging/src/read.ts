// Reading the logs back (PLAN.md, Logging, "Using it"): the Logs view shows recent lines with level and area
// filters, and Export logs writes the day's file and a run's file again, redacted a second time.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { redact } from './logger.ts';
import type { LogLevel, LogLine } from './logger.ts';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
/** The Logs view reads at most this much from the end of a file. */
export const TAIL_BYTES: number = 4 * 1024 * 1024;
/** Keys dropped from exported lines on top of redact(): seller names aren't secrets, but they aren't ours to send. */
const EXPORT_DROP_KEY: RegExp = /^(seller|account|accountName|whisper|whisper_token|hideout_token|lastCharacterName)$/i;

function isLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** One line as written by JsonlLogger, or undefined when it isn't one. */
export function parseLogLine(text: string): LogLine | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const r = value as Readonly<Record<string, unknown>>;
    const { t, level, area, msg, runId, reqId, data } = r;
    if (typeof t !== 'number' || !isLevel(level) || typeof area !== 'string' || typeof msg !== 'string') {
        return undefined;
    }
    return {
        t: t,
        level: level,
        area: area,
        msg: msg,
        ...(typeof runId === 'string' ? { runId: runId } : {}),
        ...(typeof reqId === 'string' || typeof reqId === 'number' ? { reqId: reqId } : {}),
        ...(data === undefined ? {} : { data: data }),
    };
}

function isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * The last `maxBytes` of a file as text, starting at a whole line; '' when there is no file. Opened without a
 * separate exists check, so a prune deleting the file in between can't make it throw.
 */
export function readTail(file: string, maxBytes: number = TAIL_BYTES): string {
    let fd: number;
    try {
        fd = openSync(file, 'r');
    } catch (error: unknown) {
        if (isMissing(error)) {
            return '';
        }
        throw error;
    }
    try {
        const size: number = fstatSync(fd).size;
        const start: number = Math.max(0, size - maxBytes);
        const buffer: Buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        const text: string = buffer.toString('utf8');
        return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
    } finally {
        closeSync(fd);
    }
}

export interface LogFilter {
    /** The lowest level shown (warn shows warn and error). */
    readonly minLevel: LogLevel;
    /** One area, or undefined for all. */
    readonly area?: string;
    /** Only lines of this run. */
    readonly runId?: string;
    /** Newest lines kept. */
    readonly limit: number;
}

export interface FilteredLog {
    /** Newest first. */
    readonly lines: readonly LogLine[];
    /** Every area seen in the text, for the filter. */
    readonly areas: readonly string[];
}

export function filterLog(text: string, filter: LogFilter): FilteredLog {
    const min: number = LOG_LEVELS.indexOf(filter.minLevel);
    const areas: Set<string> = new Set<string>();
    const kept: LogLine[] = [];
    for (const raw of text.split('\n')) {
        if (raw.trim() === '') {
            continue;
        }
        const line: LogLine | undefined = parseLogLine(raw);
        if (line === undefined) {
            continue;
        }
        areas.add(line.area);
        if (LOG_LEVELS.indexOf(line.level) < min) {
            continue;
        }
        if (filter.area !== undefined && line.area !== filter.area) {
            continue;
        }
        if (filter.runId !== undefined && line.runId !== filter.runId) {
            continue;
        }
        kept.push(line);
    }
    return { lines: kept.slice(-filter.limit).reverse(), areas: [...areas].sort() };
}

function dropKeys(value: unknown, depth: number = 0): unknown {
    if (depth > 12 || typeof value !== 'object' || value === null) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v: unknown) => dropKeys(v, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
        if (!EXPORT_DROP_KEY.test(k)) {
            out[k] = dropKeys(v, depth + 1);
        }
    }
    return out;
}

/** A log file's text, ready to send: every line redacted again, seller-ish keys dropped, non-log lines left out. */
export function redactForExport(text: string): string {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
        const line: LogLine | undefined = raw.trim() === '' ? undefined : parseLogLine(raw);
        if (line !== undefined) {
            out.push(JSON.stringify(dropKeys(redact(line))));
        }
    }
    return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
