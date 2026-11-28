// The check on an item as the tooltip draws it (PLAN.md, Phase 4; the shape is vocab's ItemView): a find
// from the trade site, or an equipped item from the PoB save.

import { array, boolean, oneOf, record, string, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import { ICON_ORIGIN, ITEM_INFLUENCES, ITEM_MOD_KINDS, ITEM_RARITIES, ITEM_TONES } from '@poe-upgrade-finder/vocab';
import type { ItemLine, ItemMod, ItemPart, ItemView } from '@poe-upgrade-finder/vocab';

function cells(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8) {
        throw new ValidationError(`${path}: expected a whole number of cells, 1 to 8`);
    }
    return value;
}

function part(value: unknown, path: string): ItemPart {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), tone: oneOf(r['tone'], `${path}.tone`, ITEM_TONES) };
}

function line(value: unknown, path: string): ItemLine {
    return array(value, path, part);
}

function mod(value: unknown, path: string): ItemMod {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), kind: oneOf(r['kind'], `${path}.kind`, ITEM_MOD_KINDS) };
}

/** An image URL on web.poecdn.com, or null; anything else is refused. */
export function readIcon(value: unknown, path: string): string | null {
    if (value === null) {
        return null;
    }
    const url: string = string(value, path);
    if (!url.startsWith(ICON_ORIGIN)) {
        throw new ValidationError(`${path}: icons come from ${ICON_ORIGIN} only`);
    }
    return url;
}

export function readItemView(value: unknown, path: string): ItemView {
    const r: JsonRecord = record(value, path);
    const ilvl: unknown = r['itemLevel'];
    if (ilvl !== null && (typeof ilvl !== 'number' || !Number.isFinite(ilvl))) {
        throw new ValidationError(`${path}.itemLevel: expected a number or null`);
    }
    return {
        icon: readIcon(r['icon'], `${path}.icon`),
        width: cells(r['width'], `${path}.width`),
        height: cells(r['height'], `${path}.height`),
        rarity: oneOf(r['rarity'], `${path}.rarity`, ITEM_RARITIES),
        name: string(r['name'], `${path}.name`),
        typeLine: string(r['typeLine'], `${path}.typeLine`),
        influences: array(r['influences'], `${path}.influences`, (v: unknown, p: string) => oneOf(v, p, ITEM_INFLUENCES)),
        properties: array(r['properties'], `${path}.properties`, line),
        requirements: line(r['requirements'], `${path}.requirements`),
        sockets: string(r['sockets'], `${path}.sockets`),
        itemLevel: ilvl,
        enchants: array(r['enchants'], `${path}.enchants`, mod),
        implicits: array(r['implicits'], `${path}.implicits`, mod),
        explicits: array(r['explicits'], `${path}.explicits`, mod),
        corrupted: boolean(r['corrupted'], `${path}.corrupted`),
        mirrored: boolean(r['mirrored'], `${path}.mirrored`),
    };
}

/** A missing view (a run saved before views existed) reads as null. */
export function readOptionalItemView(value: unknown, path: string): ItemView | null {
    return value === undefined || value === null ? null : readItemView(value, path);
}
