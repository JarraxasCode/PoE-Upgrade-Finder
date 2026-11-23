// Fixture listings for the CLI: "##ITEM <slot> | <label> | <price>" dumps (V5's items.txt) and recorded
// trade fetch responses (the spike's *-raw.json), in which each result has the in-game item text in
// item.extended.text (base64). Phase 2's trade package takes over reading real responses.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import { isRecord } from '@poe-upgrade-finder/validate';

export interface Price {
    readonly amount: number;
    readonly currency: string;
}

export interface Listing {
    /** The trade listing id, or <file>#<n> for a dump entry. */
    readonly id: string;
    /** The in-game item text, as PoB reads it. */
    readonly text: string;
    /** "Name, Base" (or the dump's label). */
    readonly label: string;
    /** From the text's "Rarity:" line: Rare, Magic, Normal, Unique... */
    readonly rarity: string | undefined;
    readonly price: Price | undefined;
    readonly source: string;
}

type Json = JsonRecord;

export function rarityOf(text: string): string | undefined {
    const match: RegExpMatchArray | null = /^Rarity: (\w+)/m.exec(text);
    return match?.[1];
}

/** "Name\nBase" lines after the Rarity line, joined as "Name, Base". */
function labelOf(text: string): string {
    const lines: string[] = text.replace(/\r/g, '').split('\n');
    const at: number = lines.findIndex((l: string) => l.startsWith('Rarity: '));
    const names: string[] = [];
    for (let i: number = at + 1; i < lines.length && names.length < 2; i++) {
        const line: string = lines[i] ?? '';
        if (line.startsWith('--------')) {
            break;
        }
        names.push(line.trim());
    }
    return names.join(', ');
}

export function parsePrice(text: string): Price | undefined {
    const match: RegExpMatchArray | null = /^\s*([\d.]+)\s+([a-z-]+)\s*$/i.exec(text);
    if (!match?.[1] || !match[2]) {
        return undefined;
    }
    return { amount: Number(match[1]), currency: match[2].toLowerCase() };
}

/** Parses a "##ITEM <slot> | <label> | <price>" dump. */
export function parseItemDump(dump: string, source: string): Listing[] {
    const listings: Listing[] = [];
    const parts: string[] = dump.replace(/\r/g, '').split(/^##ITEM /m);
    for (const part of parts) {
        const newline: number = part.indexOf('\n');
        if (newline < 0) {
            continue;
        }
        const header: string[] = part.slice(0, newline).split(' | ');
        const text: string = part.slice(newline + 1).replace(/\n+$/, '');
        if (text.trim() === '') {
            continue;
        }
        listings.push({
            id: `${source}#${listings.length}`,
            text: text,
            label: header[1] ?? labelOf(text),
            rarity: rarityOf(text),
            price: header[2] === undefined ? undefined : parsePrice(header[2]),
            source: source,
        });
    }
    return listings;
}

/** One trade fetch result, or undefined if the value isn't one. */
function listingFrom(value: Json, source: string): Listing | undefined {
    const listing: unknown = value['listing'];
    const item: unknown = value['item'];
    const id: unknown = value['id'];
    if (typeof id !== 'string' || !isRecord(listing) || !isRecord(item) || !isRecord(item['extended'])) {
        return undefined;
    }
    const encoded: unknown = item['extended']['text'];
    if (typeof encoded !== 'string') {
        return undefined;
    }
    const text: string = Buffer.from(encoded, 'base64').toString('utf8').replace(/\r/g, '').replace(/\n+$/, '');
    const rawPrice: unknown = listing['price'];
    let price: Price | undefined;
    if (isRecord(rawPrice) && typeof rawPrice['amount'] === 'number' && typeof rawPrice['currency'] === 'string') {
        price = { amount: rawPrice['amount'], currency: rawPrice['currency'] };
    }
    return { id: id, text: text, label: labelOf(text), rarity: rarityOf(text), price: price, source: source };
}

/** Every trade fetch result anywhere in a JSON value (a fetch response, or the spike's raw recordings). */
export function parseTradeJson(value: unknown, source: string): Listing[] {
    const found: Listing[] = [];
    const walk = (v: unknown): void => {
        if (Array.isArray(v)) {
            for (const x of v) {
                walk(x);
            }
            return;
        }
        if (!isRecord(v)) {
            return;
        }
        const listing: Listing | undefined = listingFrom(v, source);
        if (listing) {
            found.push(listing);
            return;
        }
        for (const x of Object.values(v)) {
            walk(x);
        }
    };
    walk(value);
    return found;
}

/** Reads one fixture file (JSON or ##ITEM dump). */
export function readListingsFile(path: string): Listing[] {
    const content: string = readFileSync(path, 'utf8').replace(/^﻿/, '');
    const source: string = basename(path);
    if (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) {
        const parsed: unknown = JSON.parse(content);
        return parseTradeJson(parsed, source);
    }
    return parseItemDump(content, source);
}

/** Keeps the first listing of each id. */
export function dedupe(listings: readonly Listing[]): Listing[] {
    const seen: Set<string> = new Set<string>();
    return listings.filter((l: Listing) => {
        if (seen.has(l.id)) {
            return false;
        }
        seen.add(l.id);
        return true;
    });
}
