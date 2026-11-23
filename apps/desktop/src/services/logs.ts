// The Logs view and Export logs (PLAN.md, Logging, "Using it"). Reads today's log from its tail; exports today's
// log and one run's log as a zip, every line redacted again (logs never hold secrets; this is the second check)
// and seller-ish keys dropped.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogsView, UiLogLine, UiLogLevel } from '@poe-upgrade-finder/ipc';
import { dayStamp, filterLog, readTail, redact, redactForExport, safeRunId } from '@poe-upgrade-finder/logging';
import type { LogLine } from '@poe-upgrade-finder/logging';
import { zip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

/** Data shown per line is cut here (the export keeps it whole). */
const DATA_MAX: number = 4000;

export interface LogQuery {
    readonly minLevel: UiLogLevel;
    readonly area: string | null;
    readonly runId: string | null;
    readonly limit: number;
}

export function todayLogFile(logsDir: string, nowMs: number = Date.now()): string {
    return join(logsDir, `app-${dayStamp(nowMs)}.jsonl`);
}

function toUi(line: LogLine): UiLogLine {
    let data: string | null = null;
    if (line.data !== undefined) {
        const text: string = JSON.stringify(redact(line.data));
        data = text.length > DATA_MAX ? `${text.slice(0, DATA_MAX)}…` : text;
    }
    return { t: line.t, level: line.level, area: line.area, runId: line.runId ?? null, msg: line.msg, data: data };
}

export function recentLogs(logsDir: string, query: LogQuery): LogsView {
    const file: string = todayLogFile(logsDir);
    const filtered = filterLog(readTail(file), {
        minLevel: query.minLevel,
        limit: query.limit,
        ...(query.area === null ? {} : { area: query.area }),
        ...(query.runId === null ? {} : { runId: query.runId }),
    });
    return { file: file, lines: filtered.lines.map(toUi), areas: filtered.areas };
}

/** The zip's bytes: today's log, the run's log when given and present, and a small info file. */
export function exportZip(
    logsDir: string,
    runId: string | null,
    info: Readonly<Record<string, string>>,
    nowMs: number = Date.now(),
): Buffer {
    const entries: ZipEntry[] = [];
    const today: string = todayLogFile(logsDir, nowMs);
    if (existsSync(today)) {
        entries.push({ name: `app-${dayStamp(nowMs)}.jsonl`, data: Buffer.from(redactForExport(readFileSync(today, 'utf8'))) });
    }
    if (runId !== null) {
        const runFile: string = join(logsDir, 'runs', `${safeRunId(runId)}.jsonl`);
        if (existsSync(runFile)) {
            entries.push({ name: `runs/${safeRunId(runId)}.jsonl`, data: Buffer.from(redactForExport(readFileSync(runFile, 'utf8'))) });
        }
    }
    entries.push({
        name: 'info.json',
        data: Buffer.from(JSON.stringify({ ...info, exportedAt: new Date(nowMs).toISOString(), runId: runId }, null, 2)),
    });
    return zip(entries, new Date(nowMs));
}
