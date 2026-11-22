// Item images for equipped items (PLAN.md, Phase 4, gear layout). PoB saves carry no image, so a unique gets
// its own art from data/unique-art.json and anything else its base's from data/base-art.json (both built
// from RePoE by tools/base-art/build.ts). The unsigned CDN path serves it:
// https://web.poecdn.com/image/Art/2DItems/<path>.png.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repoRoot } from '@poe-upgrade-finder/engine-client';

export interface BaseArt {
    readonly icon: string;
    readonly width: number;
    readonly height: number;
}

const ART_URL: string = 'https://web.poecdn.com/image/Art/2DItems/';
const DATA_DIR: string = join(repoRoot(), 'apps', 'desktop', 'src', 'data');

function isCells(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8;
}

/** Reads the table, skipping any entry that isn't [path, width, height]. */
export function readBaseArt(value: unknown): ReadonlyMap<string, BaseArt> {
    const table: Map<string, BaseArt> = new Map<string, BaseArt>();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return table;
    }
    for (const [name, entry] of Object.entries(value)) {
        if (!Array.isArray(entry)) {
            continue;
        }
        const [path, w, h] = entry as readonly unknown[];
        if (typeof path === 'string' && /^[A-Za-z0-9_/]+$/.test(path) && isCells(w) && isCells(h)) {
            table.set(name, { icon: `${ART_URL}${path}.png`, width: w, height: h });
        }
    }
    return table;
}

const tables: Map<string, ReadonlyMap<string, BaseArt>> = new Map<string, ReadonlyMap<string, BaseArt>>();

function table(file: string): ReadonlyMap<string, BaseArt> {
    let t: ReadonlyMap<string, BaseArt> | undefined = tables.get(file);
    if (t === undefined) {
        try {
            t = readBaseArt(JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8')));
        } catch {
            t = new Map<string, BaseArt>();
        }
        tables.set(file, t);
    }
    return t;
}

/** The art for a base type, or undefined (an unknown or new base: the slot shows no image). */
export function baseArt(baseName: string): BaseArt | undefined {
    return table('base-art.json').get(baseName);
}

/** PoB names a unique's variants "Foulborn <name>"; the art is the plain unique's. */
export function uniqueKey(name: string): string {
    return name.replace(/^Foulborn\s+/, '');
}

/** A unique's own art when it is known, else its base's. */
export function itemArt(baseName: string, uniqueName: string | null): BaseArt | undefined {
    const own: BaseArt | undefined = uniqueName === null ? undefined : table('unique-art.json').get(uniqueKey(uniqueName));
    return own ?? baseArt(baseName);
}
