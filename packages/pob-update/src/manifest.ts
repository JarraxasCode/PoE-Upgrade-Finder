// PoB's manifest.xml (written by its update_manifest.py): one <Version number>, one <Source> per part and one
// <File name part sha1> per file. The format is flat self-closing elements, so a small attribute reader is
// enough; every value is checked, and anything missing throws a ValidationError naming the element.

import { ValidationError } from '@poe-upgrade-finder/validate';

export type ManifestPart = 'default' | 'runtime' | 'program' | 'tree';

const PARTS: readonly ManifestPart[] = ['default', 'runtime', 'program', 'tree'];

/** Where each part lives in the repo layout (manifest.cfg's `path`). */
const PART_DIR: Readonly<Record<ManifestPart, string>> = {
    default: '',
    runtime: 'runtime/',
    program: 'src/',
    tree: 'src/',
};

export interface ManifestFile {
    /** The name as the manifest has it, relative to its part. `{space}` stays literal: the repo (and so a
     * repo-layout copy and the raw GitHub URL) names the file that way; only PoB's installer renames it. */
    readonly name: string;
    readonly part: ManifestPart;
    readonly sha1: string;
    /** Repo-relative path with forward slashes, e.g. `src/Modules/Data.lua`. */
    readonly path: string;
}

export interface PobManifest {
    readonly version: string;
    readonly files: readonly ManifestFile[];
}

const ELEMENT: RegExp = /<(Version|Source|File)\b([^>]*?)\/?>/g;
const ATTRIBUTE: RegExp = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(value: string): string {
    return value.replace(/&(amp|lt|gt|quot|apos);/g, (_m: string, name: string): string => {
        switch (name) {
            case 'amp': {
                return '&';
            }
            case 'lt': {
                return '<';
            }
            case 'gt': {
                return '>';
            }
            case 'quot': {
                return '"';
            }
            default: {
                return "'";
            }
        }
    });
}

function attributes(text: string): ReadonlyMap<string, string> {
    const found: Map<string, string> = new Map<string, string>();
    for (const match of text.matchAll(ATTRIBUTE)) {
        const name: string | undefined = match[1];
        const value: string | undefined = match[2] ?? match[3];
        if (name !== undefined && value !== undefined) {
            found.set(name, decodeEntities(value));
        }
    }
    return found;
}

function required(attrs: ReadonlyMap<string, string>, name: string, where: string): string {
    const value: string | undefined = attrs.get(name);
    if (value === undefined || value === '') {
        throw new ValidationError(`${where}: missing ${name}`);
    }
    return value;
}

function part(value: string, where: string): ManifestPart {
    const found: ManifestPart | undefined = PARTS.find((p: ManifestPart) => p === value);
    if (found === undefined) {
        throw new ValidationError(`${where}: unknown part ${value}`);
    }
    return found;
}

/** The repo path of a manifest name in a part. */
export function repoPath(manifestPart: ManifestPart, name: string): string {
    return PART_DIR[manifestPart] + name;
}

/**
 * Parses manifest.xml. Platform attributes on File are ignored on purpose: update_manifest.py writes
 * `runtime="win32"` but UpdateCheck.lua filters on `platform`, so PoB itself never filters files (V20).
 */
export function parseManifest(xml: string): PobManifest {
    if (!xml.includes('<PoBVersion')) {
        throw new ValidationError('manifest: no <PoBVersion> root');
    }
    let version: string | undefined;
    const files: ManifestFile[] = [];
    const seen: Set<string> = new Set<string>();
    let index: number = 0;
    for (const match of xml.matchAll(ELEMENT)) {
        const tag: string | undefined = match[1];
        const attrs: ReadonlyMap<string, string> = attributes(match[2] ?? '');
        if (tag === 'Version') {
            version = required(attrs, 'number', 'manifest.Version');
        } else if (tag === 'File') {
            const where: string = `manifest.File[${index}]`;
            const filePart: ManifestPart = part(required(attrs, 'part', where), where);
            const name: string = required(attrs, 'name', where);
            const sha1: string = required(attrs, 'sha1', where).toLowerCase();
            if (!/^[0-9a-f]{40}$/.test(sha1)) {
                throw new ValidationError(`${where}: sha1 is not 40 hex digits`);
            }
            if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
                throw new ValidationError(`${where}: unsafe name ${name}`);
            }
            const path: string = repoPath(filePart, name);
            if (seen.has(path)) {
                throw new ValidationError(`${where}: ${path} listed twice`);
            }
            seen.add(path);
            files.push({ name: name, part: filePart, sha1: sha1, path: path });
            index++;
        }
    }
    if (version === undefined) {
        throw new ValidationError('manifest: no <Version number>');
    }
    if (files.length === 0) {
        throw new ValidationError('manifest: no <File> entries');
    }
    return { version: version, files: files };
}

/** Compares dotted versions numerically (`2.68.1` > `2.9.0`). */
export function compareVersions(a: string, b: string): number {
    const pa: number[] = a.split('.').map((s: string) => Number.parseInt(s, 10));
    const pb: number[] = b.split('.').map((s: string) => Number.parseInt(s, 10));
    for (let i: number = 0; i < Math.max(pa.length, pb.length); i++) {
        const x: number = pa[i] ?? 0;
        const y: number = pb[i] ?? 0;
        if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}
