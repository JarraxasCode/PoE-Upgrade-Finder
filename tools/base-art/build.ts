// Builds apps/desktop/src/data/base-art.json (base type → art path and inventory cells) and unique-art.json
// (unique name → the same), for the images of equipped items (PoB saves have none). Sources: RePoE's
// base_items.json and uniques.json (https://repoe-fork.github.io/), downloaded by hand once per league
// and passed by path; they are never committed. Images then load from
// https://web.poecdn.com/image/Art/2DItems/<path>.png (PLAN.md, Phase 4).
//
//   node tools/base-art/build.ts <base_items.json> <uniques.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '@poe-upgrade-finder/validate';

/** Item classes the gear layout shows (no flasks, jewels or gems: out of scope). */
const CLASSES: ReadonlySet<string> = new Set<string>([
    'Helmet',
    'Body Armour',
    'Gloves',
    'Boots',
    'Amulet',
    'Ring',
    'Belt',
    'Shield',
    'Quiver',
    'Wand',
    'Dagger',
    'Rune Dagger',
    'Claw',
    'One Hand Axe',
    'One Hand Sword',
    'Thrusting One Hand Sword',
    'One Hand Mace',
    'Sceptre',
    'Bow',
    'Staff',
    'Warstaff',
    'Two Hand Axe',
    'Two Hand Sword',
    'Two Hand Mace',
    'FishingRod',
    'Trinket',
]);

const PREFIX: string = 'Art/2DItems/';

type Entry = readonly [path: string, width: number, height: number];

/** art path and cells from a RePoE entry, or undefined. */
function entryOf(value: Record<string, unknown>): Entry | undefined {
    const visual: unknown = value['visual_identity'];
    const dds: unknown = isRecord(visual) ? visual['dds_file'] : undefined;
    const w: unknown = value['inventory_width'];
    const h: unknown = value['inventory_height'];
    if (typeof dds !== 'string' || !dds.startsWith(PREFIX) || !dds.endsWith('.dds') || typeof w !== 'number' || typeof h !== 'number') {
        return undefined;
    }
    return [dds.slice(PREFIX.length, -'.dds'.length), w, h];
}

function write(table: ReadonlyMap<string, Entry>, file: string): void {
    const sorted: Record<string, Entry> = {};
    for (const name of [...table.keys()].sort()) {
        const entry: Entry | undefined = table.get(name);
        if (entry !== undefined) {
            sorted[name] = entry;
        }
    }
    const out: string = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/src/data', file);
    writeFileSync(out, `${JSON.stringify(sorted, null, 0).replace(/\],"/g, '],\n"')}\n`);
    console.log(`${table.size} entries written to ${out}`);
}

/** Uniques by name; alternate art is skipped, the first regular entry wins. */
function uniques(source: string): void {
    const data: unknown = JSON.parse(readFileSync(source, 'utf8'));
    if (!isRecord(data)) {
        throw new Error('uniques.json: expected an object keyed by id');
    }
    const table: Map<string, Entry> = new Map<string, Entry>();
    for (const value of Object.values(data)) {
        if (!isRecord(value) || value['is_alternate_art'] === true || typeof value['name'] !== 'string') {
            continue;
        }
        const entry: Entry | undefined = entryOf(value);
        if (entry !== undefined && !table.has(value['name'])) {
            table.set(value['name'], entry);
        }
    }
    write(table, 'unique-art.json');
}

function main(): void {
    const source: string | undefined = process.argv[2];
    const uniqueSource: string | undefined = process.argv[3];
    if (source === undefined || uniqueSource === undefined) {
        throw new Error('usage: node tools/base-art/build.ts <base_items.json> <uniques.json>');
    }
    const data: unknown = JSON.parse(readFileSync(source, 'utf8'));
    if (!isRecord(data)) {
        throw new Error('base_items.json: expected an object keyed by metadata id');
    }
    const table: Map<string, Entry> = new Map<string, Entry>();
    let skipped: number = 0;
    for (const value of Object.values(data)) {
        if (!isRecord(value) || value['release_state'] !== 'released' || !CLASSES.has(String(value['item_class']))) {
            continue;
        }
        const name: unknown = value['name'];
        const entry: Entry | undefined = entryOf(value);
        if (typeof name !== 'string' || entry === undefined) {
            skipped++;
            continue;
        }
        if (!table.has(name)) {
            table.set(name, entry);
        }
    }
    if (skipped > 0) {
        console.log(`${skipped} bases skipped (no art path or cells)`);
    }
    write(table, 'base-art.json');
    uniques(uniqueSource);
}

main();
