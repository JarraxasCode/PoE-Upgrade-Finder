// Small JSON files in the app-data folder: read with a check (a missing or broken file gives the fallback and
// a log line, never a crash), written atomically (temp file, then rename) so a crash can't leave half a file.

import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@poe-upgrade-finder/logging';
import { messageOf } from '@poe-upgrade-finder/validate';

export interface JsonFileRead<T> {
    /** Checks the parsed file. It may repair parts and report each through `dropped`, or throw to refuse it all. */
    readonly read: (value: unknown, path: string, dropped: (problem: string) => void) => T;
    readonly fallback: () => T;
    readonly log: Logger;
    /** After a repair: the original was kept as `backup` and the file now holds the repaired value. */
    readonly onRepair?: (repair: JsonFileRepair) => void;
}

export interface JsonFileRepair {
    readonly file: string;
    readonly backup: string;
    readonly problems: readonly string[];
}

/** `<name>.bad-<stamp>.json` beside the file. */
export function badCopyName(file: string, now: Date): string {
    const stamp: string = now.toISOString().replace(/[:.]/g, '-');
    return `${file.replace(/\.json$/i, '')}.bad-${stamp}.json`;
}

/**
 * Reads a checked JSON file. A missing file gives the fallback. A file that fails its check, wholly or in part
 * (issue #69), is copied to `<name>.bad-<stamp>.json` first and then rewritten with what was kept, so the next
 * save can't lose the original and the repair happens once. If the copy fails, the file is left alone.
 */
export function readJsonFile<T>(file: string, options: JsonFileRead<T>): T {
    const log: Logger = options.log;
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return options.fallback();
        }
        log.log('warn', 'could not read a settings file; using defaults', { file: file, error: String(error) });
        return options.fallback();
    }
    const problems: string[] = [];
    let value: T;
    try {
        value = options.read(JSON.parse(text.replace(/^﻿/, '')), 'file', (problem: string) => {
            problems.push(problem);
        });
    } catch (error: unknown) {
        problems.push(messageOf(error));
        value = options.fallback();
    }
    if (problems.length === 0) {
        return value;
    }
    const backup: string = badCopyName(file, new Date());
    try {
        copyFileSync(file, backup);
    } catch (error: unknown) {
        log.log('warn', 'a settings file is invalid and could not be backed up; left as it is', {
            file: file,
            problems: problems,
            error: messageOf(error),
        });
        return value;
    }
    try {
        writeJsonFile(file, value);
    } catch (error: unknown) {
        log.log('warn', 'could not rewrite a repaired settings file', { file: file, error: messageOf(error) });
    }
    log.log('warn', 'a settings file is invalid; kept a copy and dropped the bad parts', {
        file: file,
        backup: backup,
        problems: problems,
    });
    options.onRepair?.({ file: file, backup: backup, problems: problems });
    return value;
}

export function writeJsonFile(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const temp: string = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    try {
        renameSync(temp, file);
    } catch (error: unknown) {
        // e.g. the file is read-only: the save fails (the caller says so), but leaves no temp file behind.
        rmSync(temp, { force: true });
        throw error;
    }
}
