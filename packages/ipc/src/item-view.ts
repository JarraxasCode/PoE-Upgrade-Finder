// An item as the tooltip draws it (PLAN.md, Phase 4): a find from the trade site, or (later) an equipped
// item from the PoB save. Same shape as `ItemDisplay` in packages/trade, which main assigns straight in;
// it is declared again here because the renderer bundles this package and must not pull in the trade code.

import { array, boolean, oneOf, record, string, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';

export type ViewTone = 'plain' | 'augmented' | 'unmet' | 'fire' | 'cold' | 'lightning' | 'chaos' | 'label';
const TONES: readonly ViewTone[] = ['plain', 'augmented', 'unmet', 'fire', 'cold', 'lightning', 'chaos', 'label'];

export interface ViewPart {
    readonly text: string;
    readonly tone: ViewTone;
}

export type ViewLine = readonly ViewPart[];

export type ViewModKind = 'enchant' | 'implicit' | 'explicit' | 'crafted' | 'fractured' | 'scourge' | 'crucible';
const MOD_KINDS: readonly ViewModKind[] = ['enchant', 'implicit', 'explicit', 'crafted', 'fractured', 'scourge', 'crucible'];

export interface ViewMod {
    readonly text: string;
    readonly kind: ViewModKind;
}

export type ViewRarity = 'normal' | 'magic' | 'rare' | 'unique' | 'other';
const RARITIES: readonly ViewRarity[] = ['normal', 'magic', 'rare', 'unique', 'other'];

export type ViewInfluence = 'shaper' | 'elder' | 'crusader' | 'redeemer' | 'hunter' | 'warlord' | 'searing' | 'tangled';
const INFLUENCES: readonly ViewInfluence[] = ['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord', 'searing', 'tangled'];

export interface ItemView {
    /** An image on web.poecdn.com, or null. */
    readonly icon: string | null;
    readonly width: number;
    readonly height: number;
    readonly rarity: ViewRarity;
    readonly name: string;
    readonly typeLine: string;
    readonly influences: readonly ViewInfluence[];
    readonly properties: readonly ViewLine[];
    readonly requirements: ViewLine;
    readonly sockets: string;
    readonly itemLevel: number | null;
    readonly enchants: readonly ViewMod[];
    readonly implicits: readonly ViewMod[];
    readonly explicits: readonly ViewMod[];
    readonly corrupted: boolean;
    readonly mirrored: boolean;
}

export const ICON_PREFIX: string = 'https://web.poecdn.com/';

function cells(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8) {
        throw new ValidationError(`${path}: expected a whole number of cells, 1 to 8`);
    }
    return value;
}

function part(value: unknown, path: string): ViewPart {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), tone: oneOf(r['tone'], `${path}.tone`, TONES) };
}

function line(value: unknown, path: string): ViewLine {
    return array(value, path, part);
}

function mod(value: unknown, path: string): ViewMod {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), kind: oneOf(r['kind'], `${path}.kind`, MOD_KINDS) };
}

function icon(value: unknown, path: string): string | null {
    if (value === null) {
        return null;
    }
    const url: string = string(value, path);
    if (!url.startsWith(ICON_PREFIX)) {
        throw new ValidationError(`${path}: icons come from ${ICON_PREFIX} only`);
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
        icon: icon(r['icon'], `${path}.icon`),
        width: cells(r['width'], `${path}.width`),
        height: cells(r['height'], `${path}.height`),
        rarity: oneOf(r['rarity'], `${path}.rarity`, RARITIES),
        name: string(r['name'], `${path}.name`),
        typeLine: string(r['typeLine'], `${path}.typeLine`),
        influences: array(r['influences'], `${path}.influences`, (v: unknown, p: string) => oneOf(v, p, INFLUENCES)),
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
