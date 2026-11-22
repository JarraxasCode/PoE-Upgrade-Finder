// Builds a new PoB copy in a staging folder from the live copy plus the files that changed (PLAN.md, "The
// pob-update design", steps 1 to 5). The live copy is only read. The diff hashes the live copy's files
// rather than trusting its manifest (a dev commit's manifest is stale). Only files the new manifest lists
// are carried over, so files the new version dropped are simply not copied.

import type { Stats } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pobSha1 } from './hash.ts';
import { type ManifestFile, parseManifest, type PobManifest } from './manifest.ts';
import type { FetchedFile, PobSource } from './source.ts';

/** The headless entry point and SimpleGraphic stubs: manifest.cfg leaves them out, so they're fetched by path. */
export const HEADLESS_FILES: readonly string[] = ['src/HeadlessWrapper.lua', 'src/_SimpleGraphic.def.lua'];

/**
 * Tree images and src/Assets/: headless PoB's image Load is a stub that never opens the file, and an
 * image-free copy gave the same 5,156 output values on RF (V20). Skipping them halves the copy.
 */
export function isSkipped(path: string): boolean {
    if (path.startsWith('src/Assets/')) {
        return true;
    }
    return path.startsWith('src/TreeData/') && /\.(png|jpe?g|webp)$/i.test(path);
}

export type StageEvent =
    | { readonly kind: 'manifest'; readonly version: string; readonly files: number; readonly skipped: number }
    | { readonly kind: 'fetch'; readonly path: string; readonly bytes: number; readonly index: number; readonly total: number }
    | { readonly kind: 'kept'; readonly count: number };

export interface StageOptions {
    readonly liveDir: string;
    /** Must end in `.staging`; removed first if it exists. */
    readonly stagingDir: string;
    readonly commit: string;
    readonly source: PobSource;
    readonly onEvent?: (event: StageEvent) => void;
}

export interface FetchedEntry {
    readonly path: string;
    readonly bytes: number;
    /** Why it was fetched. */
    readonly reason: 'missing' | 'changed';
}

export interface StageReport {
    readonly version: string;
    readonly commit: string;
    readonly manifestFiles: number;
    readonly skipped: number;
    readonly kept: number;
    readonly fetched: readonly FetchedEntry[];
    /** Raw bytes downloaded, the manifest and headless files included. */
    readonly fetchedBytes: number;
    /** Bytes on the wire, counting compressed responses at their compressed size. */
    readonly wireBytes: number;
    readonly headless: readonly { readonly path: string; readonly sha1: string }[];
}

export class StageError extends Error {
    public override readonly name: string = 'StageError';
}

async function readIfFile(path: string): Promise<Uint8Array | undefined> {
    try {
        const info: Stats = await stat(path);
        if (!info.isFile()) {
            return undefined;
        }
        return new Uint8Array(await readFile(path));
    } catch {
        return undefined;
    }
}

async function writeFileAt(root: string, path: string, bytes: Uint8Array): Promise<void> {
    const full: string = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
}

export async function stageUpdate(options: StageOptions): Promise<StageReport> {
    if (!options.stagingDir.endsWith('.staging')) {
        throw new StageError(`staging folder must end in .staging: ${options.stagingDir}`);
    }
    const emit = (event: StageEvent): void => {
        options.onEvent?.(event);
    };
    let fetchedBytes: number = 0;
    let wireBytes: number = 0;
    const count = (file: FetchedFile): void => {
        fetchedBytes += file.bytes.length;
        wireBytes += file.encodedBytes ?? file.bytes.length;
    };

    const manifestFile: FetchedFile = await options.source.file(options.commit, 'manifest.xml');
    count(manifestFile);
    const manifest: PobManifest = parseManifest(new TextDecoder().decode(manifestFile.bytes));
    const wanted: readonly ManifestFile[] = manifest.files.filter((f: ManifestFile) => !isSkipped(f.path));
    emit({ kind: 'manifest', version: manifest.version, files: manifest.files.length, skipped: manifest.files.length - wanted.length });
    if (!wanted.some((f: ManifestFile) => f.path === 'LICENSE.md')) {
        throw new StageError("the manifest doesn't list LICENSE.md");
    }

    await rm(options.stagingDir, { recursive: true, force: true });
    await mkdir(options.stagingDir, { recursive: true });

    const toFetch: { file: ManifestFile; reason: 'missing' | 'changed' }[] = [];
    let kept: number = 0;
    for (const file of wanted) {
        const live: Uint8Array | undefined = await readIfFile(join(options.liveDir, file.path));
        if (live === undefined) {
            toFetch.push({ file: file, reason: 'missing' });
        } else if (pobSha1(live) !== file.sha1) {
            toFetch.push({ file: file, reason: 'changed' });
        } else {
            await mkdir(dirname(join(options.stagingDir, file.path)), { recursive: true });
            await copyFile(join(options.liveDir, file.path), join(options.stagingDir, file.path));
            kept++;
        }
    }
    emit({ kind: 'kept', count: kept });

    const fetched: FetchedEntry[] = [];
    for (const [i, entry] of toFetch.entries()) {
        const got: FetchedFile = await options.source.file(options.commit, entry.file.path);
        count(got);
        const sha1: string = pobSha1(got.bytes);
        if (sha1 !== entry.file.sha1) {
            throw new StageError(`${entry.file.path}: sha1 ${sha1} doesn't match the manifest's ${entry.file.sha1}`);
        }
        await writeFileAt(options.stagingDir, entry.file.path, got.bytes);
        fetched.push({ path: entry.file.path, bytes: got.bytes.length, reason: entry.reason });
        emit({ kind: 'fetch', path: entry.file.path, bytes: got.bytes.length, index: i + 1, total: toFetch.length });
    }

    const headless: { path: string; sha1: string }[] = [];
    for (const path of HEADLESS_FILES) {
        const got: FetchedFile = await options.source.file(options.commit, path);
        count(got);
        await writeFileAt(options.stagingDir, path, got.bytes);
        headless.push({ path: path, sha1: pobSha1(got.bytes) });
    }

    // Verbatim: PoB reads its version from it.
    await writeFileAt(options.stagingDir, 'manifest.xml', manifestFile.bytes);

    return {
        version: manifest.version,
        commit: options.commit,
        manifestFiles: manifest.files.length,
        skipped: manifest.files.length - wanted.length,
        kept: kept,
        fetched: fetched,
        fetchedBytes: fetchedBytes,
        wireBytes: wireBytes,
        headless: headless,
    };
}

/**
 * Files we rebuild after verifying, so they no longer match PoB's manifest: QueryMods.lua is rebuilt with
 * PoB's own code (engine/lua/querymods-rebuild.lua). verifyCopy only checks that they exist.
 */
export const REBUILT_FILES: readonly string[] = ['src/Data/QueryMods.lua'];

/**
 * Re-hashes every non-skipped manifest file in a copy. Returns the paths that are missing or don't match.
 * With `allowRebuilt`, REBUILT_FILES only need to exist (a copy after its rebuild).
 */
export async function verifyCopy(dir: string, manifest: PobManifest, allowRebuilt: boolean = false): Promise<readonly string[]> {
    const bad: string[] = [];
    for (const file of manifest.files) {
        if (isSkipped(file.path)) {
            continue;
        }
        const bytes: Uint8Array | undefined = await readIfFile(join(dir, file.path));
        const rebuilt: boolean = allowRebuilt && REBUILT_FILES.includes(file.path);
        if (bytes === undefined || (!rebuilt && pobSha1(bytes) !== file.sha1)) {
            bad.push(file.path);
        }
    }
    for (const path of HEADLESS_FILES) {
        if ((await readIfFile(join(dir, path))) === undefined) {
            bad.push(path);
        }
    }
    return bad;
}
