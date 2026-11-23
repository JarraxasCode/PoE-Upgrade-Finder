// Rebuilds a PoB copy's Data/QueryMods.lua with engine/lua/querymods-rebuild.lua (offline; PLAN.md, V7 and
// "The pob-update design" step 3). Used by tools/pob-update and the in-app PoB update, on a copy nothing runs.

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { number, record, toError, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import type { EnginePaths } from './config.ts';

export interface QueryModsReport {
    readonly seconds: number;
    /** Entries per mod type (Explicit, Implicit, Corrupted, ...). */
    readonly entries: Readonly<Record<string, number>>;
    /** Mod lines PoB couldn't map to a trade stat (252 on 2.67.2 and 2.68.1, none that matter for v1's rares). */
    readonly unmatched: number;
}

/** The last line of the script's output, checked. A rebuild with fewer than 1,000 explicit families is refused. */
export function readQueryModsReport(stdout: string): QueryModsReport {
    const last: string = stdout.trim().split(/\r?\n/).pop() ?? '';
    let value: unknown;
    try {
        value = JSON.parse(last);
    } catch {
        throw new ValidationError(`querymods: no JSON result (last line: ${last.slice(0, 200)})`);
    }
    const r: JsonRecord = record(value, 'querymods');
    if (r['ok'] !== true) {
        throw new ValidationError('querymods: not ok');
    }
    const entriesIn: JsonRecord = record(r['entries'], 'querymods.entries');
    const entries: Record<string, number> = {};
    for (const [key, n] of Object.entries(entriesIn)) {
        entries[key] = number(n, `querymods.entries.${key}`);
    }
    if ((entries['Explicit'] ?? 0) < 1000) {
        throw new ValidationError(`querymods: only ${entries['Explicit'] ?? 0} explicit families; refusing it`);
    }
    return {
        seconds: number(r['seconds'], 'querymods.seconds'),
        entries: entries,
        unmatched: number(r['unmatched'], 'querymods.unmatched'),
    };
}

export function rebuildQueryMods(paths: EnginePaths, timeoutMs: number = 180_000): Promise<QueryModsReport> {
    const outDir: string = mkdtempSync(join(tmpdir(), 'poe-uf-querymods-'));
    const runtime: string = join(paths.pobDir, 'runtime');
    const script: string = join(paths.dispatcherPath, '..', 'querymods-rebuild.lua');
    return new Promise<QueryModsReport>((resolve: (r: QueryModsReport) => void, reject: (e: Error) => void) => {
        const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
            paths.luahostPath,
            [runtime, join(paths.pobDir, 'src'), script, outDir],
            {
                env: {
                    ...process.env,
                    LUA_PATH: '../runtime/lua/?.lua;../runtime/lua/?/init.lua;./?.lua;;',
                    LUA_CPATH: join(runtime, '?.dll'),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            },
        );
        let stdout: string = '';
        let stderr: string = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        const timer: NodeJS.Timeout = setTimeout(() => {
            child.kill();
        }, timeoutMs);
        const cleanUp = (): void => {
            clearTimeout(timer);
            rmSync(outDir, { recursive: true, force: true });
        };
        child.on('error', (error: Error) => {
            cleanUp();
            reject(error);
        });
        child.on('close', (code: number | null) => {
            try {
                if (code !== 0) {
                    throw new Error(
                        `QueryMods rebuild exited ${code ?? 'killed'}: ${(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' | ')}`,
                    );
                }
                const report: QueryModsReport = readQueryModsReport(stdout);
                copyFileSync(join(outDir, 'QueryMods.lua'), join(paths.pobDir, 'src', 'Data', 'QueryMods.lua'));
                cleanUp();
                resolve(report);
            } catch (error: unknown) {
                cleanUp();
                reject(toError(error));
            }
        });
    });
}
