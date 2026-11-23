// Small JSON files in the app-data folder: read with a check (a missing or broken file gives the fallback and
// a log line, never a crash), written atomically (temp file, then rename) so a crash can't leave half a file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@poe-upgrade-finder/logging';
import { messageOf } from '@poe-upgrade-finder/validate';

export function readJsonFile<T>(file: string, read: (value: unknown, path: string) => T, fallback: () => T, log: Logger): T {
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return fallback();
        }
        log.log('warn', 'could not read a settings file; using defaults', { file: file, error: String(error) });
        return fallback();
    }
    try {
        return read(JSON.parse(text.replace(/^﻿/, '')), 'file');
    } catch (error: unknown) {
        log.log('warn', 'a settings file is invalid; using defaults', {
            file: file,
            error: messageOf(error),
        });
        return fallback();
    }
}

export function writeJsonFile(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const temp: string = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, file);
}
