// What a tooltip shows for a fetched item (PLAN.md, Phase 4, "Item images and tooltips"): the image, the
// name lines, properties, requirements, sockets, the mod groups and the corrupted line, read from the fetch
// response's item. Best effort: tooltip data never fails a listing (the item text and stat ids do that), so
// anything unexpected here is left out rather than thrown.

import { isRecord } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import { ICON_ORIGIN, ITEM_INFLUENCES, ITEM_MOD_KINDS } from '@poe-upgrade-finder/vocab';
import type { ItemInfluence, ItemLine, ItemMod, ItemModKind, ItemPart, ItemRarity, ItemTone, ItemView } from '@poe-upgrade-finder/vocab';

const TONES: Readonly<Record<number, ItemTone>> = {
    0: 'plain',
    1: 'augmented',
    2: 'unmet',
    3: 'plain',
    4: 'fire',
    5: 'cold',
    6: 'lightning',
    7: 'chaos',
};

/** "[Poison|Poisons]" → "Poisons", "[Onslaught]" → "Onslaught" (the site's link markup). */
export function stripMarkup(text: string): string {
    return text.replace(/\[([^\]|]*\|)?([^\]]*)\]/g, '$2');
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function int(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

function readRarity(item: JsonRecord): ItemRarity {
    const r: string = (str(item['rarity']) ?? '').toLowerCase();
    if (r === 'normal' || r === 'magic' || r === 'rare' || r === 'unique') {
        return r;
    }
    switch (int(item['frameType'])) {
        case 0:
            return 'normal';
        case 1:
            return 'magic';
        case 2:
            return 'rare';
        case 3:
            return 'unique';
        default:
            return 'other';
    }
}

/** A property or requirement's values: [["233", 1], ...]. */
function readValues(value: unknown): ItemPart[] {
    const parts: ItemPart[] = [];
    for (const v of list(value)) {
        if (Array.isArray(v) && typeof v[0] === 'string') {
            parts.push({ text: v[0], tone: TONES[int(v[1]) ?? 0] ?? 'plain' });
        }
    }
    return parts;
}

function joinValues(values: readonly ItemPart[]): ItemPart[] {
    const out: ItemPart[] = [];
    values.forEach((v: ItemPart, k: number) => {
        if (k > 0) {
            out.push({ text: ', ', tone: 'label' });
        }
        out.push(v);
    });
    return out;
}

/**
 * One property line by its display mode: 0 "Name: v", 1 "v Name", 3 a template with {0}, {1}... A property
 * with no values is just its name (a weapon's class line). Mode 2 (an experience bar) isn't shown.
 */
export function propertyLine(value: unknown): ItemLine | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const name: string = stripMarkup(str(value['name']) ?? '');
    const values: ItemPart[] = readValues(value['values']);
    const mode: number = int(value['displayMode']) ?? 0;
    if (values.length === 0) {
        return name === '' ? undefined : [{ text: name, tone: 'label' }];
    }
    if (mode === 1) {
        return [...joinValues(values), { text: ` ${name}`, tone: 'label' }];
    }
    if (mode === 3) {
        const parts: ItemPart[] = [];
        for (const piece of name.split(/(\{\d+\})/)) {
            const m: RegExpMatchArray | null = /^\{(\d+)\}$/.exec(piece);
            const v: ItemPart | undefined = m === null ? undefined : values[Number(m[1])];
            if (v !== undefined) {
                parts.push(v);
            } else if (piece !== '') {
                parts.push({ text: piece, tone: 'label' });
            }
        }
        return parts;
    }
    if (mode === 2) {
        return undefined;
    }
    return [{ text: name === '' ? '' : `${name}: `, tone: 'label' }, ...joinValues(values)];
}

/** "Requires Level 64, Dex 62, Int 62": name then value, as poe.ninja shows it. */
function requirementsLine(value: unknown): ItemLine {
    const parts: ItemPart[] = [];
    for (const r of list(value)) {
        if (!isRecord(r)) {
            continue;
        }
        const name: string = stripMarkup(str(r['name']) ?? '');
        const values: ItemPart[] = readValues(r['values']);
        if (name === '' || values.length === 0) {
            continue;
        }
        parts.push({ text: parts.length === 0 ? `Requires ${name} ` : `, ${name} `, tone: 'label' }, ...joinValues(values));
    }
    return parts;
}

/** Sockets as in game: linked sockets joined by "-", groups by a space ("R-G-B B"). */
function socketsText(value: unknown): string {
    let out: string = '';
    let lastGroup: number | undefined;
    for (const s of list(value)) {
        if (!isRecord(s)) {
            continue;
        }
        const colour: string = str(s['sColour']) ?? '?';
        const group: number = int(s['group']) ?? -1;
        out += lastGroup === undefined ? colour : group === lastGroup ? `-${colour}` : ` ${colour}`;
        lastGroup = group;
    }
    return out;
}

function isModKind(value: string | undefined): value is ItemModKind {
    return value !== undefined && (ITEM_MOD_KINDS as readonly string[]).includes(value);
}

/** A mod group: strings (the public API) or { description, domain } objects (the signed-in site). */
function readMods(value: unknown, kind: ItemModKind): ItemMod[] {
    const mods: ItemMod[] = [];
    for (const m of list(value)) {
        const text: string | undefined = typeof m === 'string' ? m : isRecord(m) ? str(m['description']) : undefined;
        if (text === undefined) {
            continue;
        }
        const domain: string | undefined = isRecord(m) ? str(m['domain']) : undefined;
        const k: ItemModKind = isModKind(domain) ? domain : kind;
        for (const line of stripMarkup(text).split('\n')) {
            if (line.trim() !== '') {
                mods.push({ text: line, kind: k });
            }
        }
    }
    return mods;
}

function readInfluences(item: JsonRecord): ItemInfluence[] {
    const out: ItemInfluence[] = [];
    const influences: unknown = item['influences'];
    for (const i of ITEM_INFLUENCES) {
        const on: boolean = (isRecord(influences) && influences[i] === true) || item[i] === true;
        if (on) {
            out.push(i);
        }
    }
    return out;
}

function readIcon(value: unknown): string | null {
    const url: string | undefined = str(value);
    return url !== undefined && url.startsWith(ICON_ORIGIN) ? url : null;
}

/** The tooltip data for a fetch response's `item`. Never throws. */
export function readItemDisplay(value: unknown): ItemView {
    const item: JsonRecord = isRecord(value) ? value : {};
    const rarity: ItemRarity = readRarity(item);
    const typeLine: string = stripMarkup(str(item['typeLine']) ?? str(item['baseType']) ?? '');
    const properties: ItemLine[] = [];
    for (const p of list(item['properties'])) {
        const line: ItemLine | undefined = propertyLine(p);
        if (line !== undefined) {
            properties.push(line);
        }
    }
    return {
        icon: readIcon(item['icon']),
        width: int(item['w']) ?? 1,
        height: int(item['h']) ?? 1,
        rarity: rarity,
        name: rarity === 'rare' || rarity === 'unique' ? stripMarkup(str(item['name']) ?? '') : '',
        typeLine: typeLine,
        influences: readInfluences(item),
        properties: properties,
        requirements: requirementsLine(item['requirements']),
        sockets: socketsText(item['sockets']),
        itemLevel: int(item['ilvl']) ?? null,
        enchants: readMods(item['enchantMods'], 'enchant'),
        implicits: readMods(item['implicitMods'], 'implicit'),
        explicits: [
            ...readMods(item['fracturedMods'], 'fractured'),
            ...readMods(item['explicitMods'], 'explicit'),
            ...readMods(item['craftedMods'], 'crafted'),
            ...readMods(item['scourgeMods'], 'scourge'),
            ...readMods(item['crucibleMods'], 'crucible'),
        ],
        corrupted: item['corrupted'] === true,
        mirrored: item['duplicated'] === true,
    };
}
