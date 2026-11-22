// The PoB Builds folder and the saves in it (PLAN.md, How it works, step 1: the path comes from PoB's own
// settings, and the user can override it). Read only: the app never writes to PoB's files.
//
// PoB (Modules/Main.lua) keeps its settings in <Documents>/Path of Building/Settings.xml; the Builds folder
// is <that folder>/Builds unless <Misc buildPath="…"> overrides it.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BuildEntry, BuildsDirSource, BuildsList } from '@poe-upgrade-finder/ipc';

export interface BuildsDir {
    readonly dir: string;
    readonly source: BuildsDirSource;
}

/** XML attribute text → plain text (the five entities PoB writes). */
function unescapeXml(s: string): string {
    return s.replace(/&(quot|apos|lt|gt|amp);/g, (_m: string, e: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[e] ?? '');
}

/** One attribute of the first <tag …> in some XML text. */
export function xmlAttribute(xml: string, tag: string, name: string): string | undefined {
    const element: RegExpExecArray | null = new RegExp(`<${tag}\\b([^>]*)>`).exec(xml);
    if (element?.[1] === undefined) {
        return undefined;
    }
    const attr: RegExpExecArray | null = new RegExp(`\\s${name}="([^"]*)"`).exec(element[1]);
    return attr?.[1] === undefined ? undefined : unescapeXml(attr[1]);
}

export function pobSettingsDir(documentsDir: string): string {
    return join(documentsDir, 'Path of Building');
}

/** Where the saves are: the user's override, else PoB's own setting, else PoB's default. */
export function resolveBuildsDir(documentsDir: string, override: string | null): BuildsDir {
    if (override !== null) {
        return { dir: resolve(override), source: 'override' };
    }
    const settingsDir: string = pobSettingsDir(documentsDir);
    try {
        const xml: string = readFileSync(join(settingsDir, 'Settings.xml'), 'utf8');
        const custom: string | undefined = xmlAttribute(xml, 'Misc', 'buildPath');
        if (custom !== undefined && custom.trim() !== '') {
            return { dir: resolve(custom), source: 'pob-settings' };
        }
    } catch {
        // No Settings.xml (PoB never run, or a portable install): PoB's default.
    }
    return { dir: join(settingsDir, 'Builds'), source: 'pob-default' };
}

const HEADER_BYTES: number = 4096;

function readHead(file: string): string {
    const fd: number = openSync(file, 'r');
    try {
        const buffer: Buffer = Buffer.alloc(HEADER_BYTES);
        const n: number = readSync(fd, buffer, 0, HEADER_BYTES, 0);
        return buffer.subarray(0, n).toString('utf8');
    } finally {
        closeSync(fd);
    }
}

function intOrNull(s: string | undefined): number | null {
    const n: number = Number(s);
    return s === undefined || !Number.isInteger(n) ? null : n;
}

/** A save's entry from the start of its file, or undefined when it isn't a PoB build. */
export function buildEntryFromHead(id: string, head: string, modifiedMs: number): BuildEntry | undefined {
    if (!head.includes('<PathOfBuilding')) {
        return undefined;
    }
    const parts: string[] = id.split('/');
    const file: string = parts.pop() ?? id;
    const ascend: string | undefined = xmlAttribute(head, 'Build', 'ascendClassName');
    return {
        id: id,
        name: file.replace(/\.xml$/i, ''),
        folder: parts.join('/'),
        className: xmlAttribute(head, 'Build', 'className') ?? null,
        ascendClassName: ascend === undefined || ascend === 'None' ? null : ascend,
        level: intOrNull(xmlAttribute(head, 'Build', 'level')),
        modifiedMs: modifiedMs,
    };
}

const MAX_DEPTH: number = 4;

/** Every PoB save under the folder (a few levels of sub-folders, as PoB's own folders), newest first. */
export function listBuilds(found: BuildsDir): BuildsList {
    const builds: BuildEntry[] = [];
    const walk = (dir: string, depth: number): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full: string = join(dir, entry.name);
            if (entry.isDirectory() && depth < MAX_DEPTH) {
                walk(full, depth + 1);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
                try {
                    const stats: Stats = statSync(full);
                    const id: string = relative(found.dir, full).split(sep).join('/');
                    const built: BuildEntry | undefined = buildEntryFromHead(id, readHead(full), stats.mtimeMs);
                    if (built !== undefined) {
                        builds.push(built);
                    }
                } catch {
                    // A file that vanished or can't be read is left out.
                }
            }
        }
    };
    try {
        if (!statSync(found.dir).isDirectory()) {
            return { dir: found.dir, source: found.source, builds: [], error: `${found.dir} is not a folder.` };
        }
    } catch {
        return { dir: found.dir, source: found.source, builds: [], error: `The PoB Builds folder wasn't found: ${found.dir}. Set it in Settings.` };
    }
    walk(found.dir, 0);
    builds.sort((a: BuildEntry, b: BuildEntry) => b.modifiedMs - a.modifiedMs);
    return { dir: found.dir, source: found.source, builds: builds, error: null };
}

/** The save's full path, only if the id stays inside the folder (ids come from the renderer). */
export function buildFilePath(buildsDir: string, buildId: string): string | undefined {
    const full: string = resolve(buildsDir, ...buildId.split('/'));
    const rel: string = relative(resolve(buildsDir), full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !full.toLowerCase().endsWith('.xml')) {
        return undefined;
    }
    return full;
}
