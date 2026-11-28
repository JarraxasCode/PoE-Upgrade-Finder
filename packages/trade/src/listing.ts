// Trade responses, validated as they come in (PLAN.md, Trade client, "Endpoints"). A fetched listing's
// item.extended.text (base64) is the in-game Ctrl+C text; V5 showed it goes straight into PoB's parser once
// the trailing "Note:" section (the seller's price note) is removed.

import { array, boolean, isRecord, number, optional, record, string, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import { readItemDisplay, stripMarkup } from './item-display.ts';
import type { ItemView } from '@poe-upgrade-finder/vocab';

export interface SearchResponse {
    /** The search id; fetches may pass it as ?query= (V16: not needed). */
    readonly id: string;
    /** Listing ids, best first by the search's sort; at most 100. */
    readonly ids: readonly string[];
    /** Matching listings, capped at 10,000 by the site (V11). */
    readonly total: number;
    readonly inexact: boolean;
    /** The site's complexity for the query (V8), when it reports one. */
    readonly complexity: number | undefined;
}

export interface ListingPrice {
    readonly amount: number;
    /** The site's currency id: "chaos", "divine", ... */
    readonly currency: string;
    /** "~b/o", "~price", ... */
    readonly type: string;
}

export interface TradeListing {
    readonly id: string;
    /** The in-game item text without the Note section, LF line endings. */
    readonly text: string;
    readonly name: string;
    readonly baseType: string;
    readonly typeLine: string;
    /** "Rare", "Magic", "Normal", "Unique"... */
    readonly rarity: string;
    readonly ilvl: number | undefined;
    readonly identified: boolean;
    readonly corrupted: boolean;
    readonly price: ListingPrice | undefined;
    /** When the listing was indexed (ISO time), if given. */
    readonly indexed: string | undefined;
    /** The seller's account name: used for buy links and the "listed twice by one seller" junk rule. Never logged. */
    readonly seller: string | undefined;
    /**
     * The item's own mod lines as trade stat ids (item.extended.hashes): explicit, crafted, fractured and
     * the like, not implicit (the base gives those). Buy links require them to pin the listing down.
     */
    readonly statIds: readonly string[];
    /**
     * Every mod line with its trade stat id, implicits included (issue #6: which lines met an include).
     * Empty when the response doesn't tie lines to stats.
     */
    readonly statLines: readonly StatLine[];
    /**
     * Each line of item.extended.hashes with the mods behind it (G19): a hybrid's stats share one mod index in one
     * domain, so this tells the hybrid apart from the same stats on separate mods (#38). Empty when not given.
     */
    readonly statSources: readonly StatSource[];
    /** What a tooltip shows (image, properties, mod groups); best effort, never fails the listing. */
    readonly display: ItemView;
}

/** The kinds of mod line a StatLine can be. */
export type StatLineKind = 'implicit' | 'explicit' | 'crafted' | 'fractured' | 'scourge' | 'crucible' | 'enchant';
export const STAT_LINE_KINDS: readonly StatLineKind[] = ['implicit', 'explicit', 'crafted', 'fractured', 'scourge', 'crucible', 'enchant'];

/** One mod line on a listed item, tied to its trade stat. */
export interface StatLine {
    /** The site's stat id with the line's kind, e.g. "crafted.stat_2250533757". */
    readonly statId: string;
    readonly kind: StatLineKind;
    /** The line as shown, markup removed ("+14% to Item Rarity"). */
    readonly text: string;
}

/** One line of item.extended.hashes: a stat in one domain and the indices of the mods that carry it. */
export interface StatSource {
    readonly kind: StatLineKind;
    /** As the hashes name it, with the domain: "crafted.stat_2250533757". */
    readonly statId: string;
    /** Indices into the domain's mods; two or more when the line is summed from several mods. */
    readonly mods: readonly number[];
}

export interface FetchResponse {
    /** Listings in the order the ids were asked for. */
    readonly listings: readonly TradeListing[];
    /** Ids asked for that came back null or not at all (sold or delisted). */
    readonly missing: readonly string[];
    /** Entries that failed validation: skipped one by one, so the rest of the batch is still scored. */
    readonly malformed: readonly MalformedListing[];
}

export interface MalformedListing {
    /** The entry's id when it had a readable one (then it is not also in missing). */
    readonly id: string | null;
    /** The validation message: the field's path and what it held. */
    readonly error: string;
}

function decodeText(encoded: string): string {
    const text: string = Buffer.from(encoded, 'base64').toString('utf8').replace(/\r/g, '');
    return stripNote(text);
}

/** Removes a trailing "--------\nNote: ..." section and trailing blank lines. */
export function stripNote(text: string): string {
    return text
        .replace(/\n+$/, '')
        .replace(/(?:\n--------\nNote: [^\n]*)+$/, '')
        .replace(/\n+$/, '');
}

/** Kinds of mod line that belong to the item itself rather than its base. */
const OWN_STAT_KINDS: ReadonlySet<string> = new Set<string>(['explicit', 'crafted', 'fractured', 'scourge', 'crucible']);

/** Stat ids from item.extended.hashes: { kind: [[statId, [modIndex...]], ...] }. Anything unexpected is skipped. */
function readStatIds(value: unknown): string[] {
    if (!isRecord(value)) {
        return [];
    }
    const ids: string[] = [];
    for (const [kind, entries] of Object.entries(value)) {
        if (!OWN_STAT_KINDS.has(kind) || !Array.isArray(entries)) {
            continue;
        }
        for (const entry of entries) {
            const id: unknown = Array.isArray(entry) ? entry[0] : undefined;
            if (typeof id === 'string' && !ids.includes(id)) {
                ids.push(id);
            }
        }
    }
    return ids;
}

function isStatLineKind(value: string): value is StatLineKind {
    return (STAT_LINE_KINDS as readonly string[]).includes(value);
}

/** item.extended.hashes as stat sources: { kind: [[statId, [modIndex...]], ...] }. Anything unexpected is skipped. */
function readStatSources(value: unknown): StatSource[] {
    if (!isRecord(value)) {
        return [];
    }
    const out: StatSource[] = [];
    for (const [kind, entries] of Object.entries(value)) {
        if (!isStatLineKind(kind) || !Array.isArray(entries)) {
            continue;
        }
        for (const entry of entries) {
            if (!Array.isArray(entry)) {
                continue;
            }
            const id: unknown = entry[0];
            const list: unknown = entry[1];
            const mods: number[] = [];
            if (Array.isArray(list)) {
                for (const m of list) {
                    if (typeof m === 'number' && Number.isInteger(m) && m >= 0) {
                        mods.push(m);
                    }
                }
            }
            if (typeof id === 'string' && Array.isArray(list) && mods.length > 0 && mods.length === list.length) {
                out.push({ kind: kind, statId: id, mods: mods });
            }
        }
    }
    return out;
}

/**
 * Each mod line with its stat. The signed-in site tags every line object with its own hash
 * ("stat.explicit.stat_X"); the public format has plain strings, matched to item.extended.hashes[kind] by
 * position (one entry per line), and only when the counts agree. Anything else is left out.
 */
function readStatLines(item: JsonRecord, hashes: unknown): StatLine[] {
    const out: StatLine[] = [];
    for (const kind of STAT_LINE_KINDS) {
        const mods: unknown = item[`${kind}Mods`];
        if (!Array.isArray(mods)) {
            continue;
        }
        const byPosition: unknown = isRecord(hashes) ? hashes[kind] : undefined;
        const positional: readonly unknown[] = Array.isArray(byPosition) && byPosition.length === mods.length ? byPosition : [];
        mods.forEach((m: unknown, k: number) => {
            let text: string | undefined;
            let statId: string | undefined;
            let lineKind: StatLineKind = kind;
            if (isRecord(m)) {
                text = typeof m['description'] === 'string' ? m['description'] : undefined;
                const hash: unknown = m['hash'];
                statId = typeof hash === 'string' ? hash.replace(/^stat\./, '') : undefined;
                const domain: unknown = m['domain'];
                if (typeof domain === 'string' && isStatLineKind(domain)) {
                    lineKind = domain;
                }
            } else if (typeof m === 'string') {
                text = m;
                const entry: unknown = positional[k];
                const id: unknown = Array.isArray(entry) ? entry[0] : undefined;
                statId = typeof id === 'string' ? id : undefined;
            }
            if (text !== undefined && statId !== undefined && /^[a-z]+\.stat_\d+$/.test(statId)) {
                out.push({ statId: statId, kind: lineKind, text: stripMarkup(text).replace(/\n/g, ' / ') });
            }
        });
    }
    return out;
}

function readPrice(value: unknown, path: string): ListingPrice | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const amount: unknown = value['amount'];
    const currency: unknown = value['currency'];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || typeof currency !== 'string') {
        throw new ValidationError(`${path}: a price needs a number amount and a string currency`);
    }
    return { amount: amount, currency: currency, type: optional(value['type'], `${path}.type`, string) ?? '' };
}

export function readListing(value: unknown, path: string): TradeListing {
    const r: JsonRecord = record(value, path);
    const listing: JsonRecord = record(r['listing'], `${path}.listing`);
    const item: JsonRecord = record(r['item'], `${path}.item`);
    const extended: JsonRecord = record(item['extended'], `${path}.item.extended`);
    const account: unknown = listing['account'];
    return {
        id: string(r['id'], `${path}.id`),
        text: decodeText(string(extended['text'], `${path}.item.extended.text`)),
        name: optional(item['name'], `${path}.item.name`, string) ?? '',
        baseType: string(item['baseType'], `${path}.item.baseType`),
        typeLine: optional(item['typeLine'], `${path}.item.typeLine`, string) ?? '',
        rarity: optional(item['rarity'], `${path}.item.rarity`, string) ?? '',
        ilvl: optional(item['ilvl'], `${path}.item.ilvl`, number),
        identified: optional(item['identified'], `${path}.item.identified`, boolean) ?? true,
        corrupted: optional(item['corrupted'], `${path}.item.corrupted`, boolean) ?? false,
        price: readPrice(listing['price'], `${path}.listing.price`),
        indexed: optional(listing['indexed'], `${path}.listing.indexed`, string),
        seller: isRecord(account) ? optional(account['name'], `${path}.listing.account.name`, string) : undefined,
        statIds: readStatIds(extended['hashes']),
        statLines: readStatLines(item, extended['hashes']),
        statSources: readStatSources(extended['hashes']),
        display: readItemDisplay(item),
    };
}

export function readSearchResponse(value: unknown): SearchResponse {
    const path: string = 'search';
    const r: JsonRecord = record(value, path);
    const complexity: unknown = r['complexity'];
    return {
        id: string(r['id'], `${path}.id`),
        ids: array(r['result'], `${path}.result`, string),
        total: number(r['total'], `${path}.total`),
        inexact: optional(r['inexact'], `${path}.inexact`, boolean) ?? false,
        complexity: typeof complexity === 'number' ? complexity : undefined,
    };
}

/** A fetch response, matched to the ids asked for. Null entries (gone listings) become missing ids. */
export function readFetchResponse(value: unknown, requested: readonly string[]): FetchResponse {
    const path: string = 'fetch';
    const r: JsonRecord = record(value, path);
    const result: unknown = r['result'];
    if (!Array.isArray(result)) {
        throw new ValidationError(`${path}.result: expected an array`);
    }
    const byId: Map<string, TradeListing> = new Map<string, TradeListing>();
    const malformed: MalformedListing[] = [];
    result.forEach((entry: unknown, i: number) => {
        if (entry === null) {
            return;
        }
        try {
            const listing: TradeListing = readListing(entry, `${path}.result[${i}]`);
            byId.set(listing.id, listing);
        } catch (error: unknown) {
            if (!(error instanceof ValidationError)) {
                throw error;
            }
            const id: unknown = isRecord(entry) ? entry['id'] : undefined;
            malformed.push({ id: typeof id === 'string' ? id : null, error: error.message });
        }
    });
    const malformedIds: Set<string> = new Set<string>();
    for (const m of malformed) {
        if (m.id !== null) {
            malformedIds.add(m.id);
        }
    }
    const listings: TradeListing[] = [];
    const missing: string[] = [];
    for (const id of requested) {
        const listing: TradeListing | undefined = byId.get(id);
        if (listing !== undefined) {
            listings.push(listing);
        } else if (!malformedIds.has(id)) {
            missing.push(id);
        }
    }
    return { listings: listings, missing: missing, malformed: malformed };
}

/** The site's error body: {"error": {"code": n, "message": "..."}}. */
export function readSiteError(value: unknown): { readonly code: number | undefined; readonly message: string } | undefined {
    if (!isRecord(value) || !isRecord(value['error'])) {
        return undefined;
    }
    const error: JsonRecord = value['error'];
    return {
        code: typeof error['code'] === 'number' ? error['code'] : undefined,
        message: typeof error['message'] === 'string' ? error['message'] : 'unknown error',
    };
}

/** Removes per-listing whisper / hideout tokens before a raw response is saved (never kept). */
export function stripTokens(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripTokens);
    }
    if (isRecord(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value)) {
            if (!/token|whisper/i.test(key)) {
                out[key] = stripTokens(v);
            }
        }
        return out;
    }
    return value;
}
