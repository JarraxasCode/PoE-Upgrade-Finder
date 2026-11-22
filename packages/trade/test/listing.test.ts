import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFetchResponse, readSearchResponse, readSiteError, stripNote, stripTokens } from '../src/listing.ts';
import type { FetchResponse, TradeListing } from '../src/listing.ts';
import { listingJson } from './helpers.ts';

test('stripNote removes the trailing Note section and blank lines', () => {
    assert.equal(stripNote('Rarity: Rare\nX\n--------\n+1 to Life\n--------\nNote: ~b/o 5 chaos\n'), 'Rarity: Rare\nX\n--------\n+1 to Life');
    assert.equal(stripNote('Rarity: Rare\nX\n--------\n+1 to Life\n'), 'Rarity: Rare\nX\n--------\n+1 to Life');
});

test('reads a fetched listing: text decoded, CR and Note removed, price and seller kept', () => {
    const fetched: FetchResponse = readFetchResponse({ result: [listingJson('a', 115, 'chaos')] }, ['a']);
    const listing: TradeListing | undefined = fetched.listings[0];
    assert.ok(listing);
    assert.equal(listing.id, 'a');
    assert.ok(listing.text.startsWith('Item Class: Boots\nRarity: Rare\nGloom Spark\nSorcerer Boots'));
    assert.ok(listing.text.endsWith('25% increased Movement Speed'));
    assert.ok(!listing.text.includes('\r') && !listing.text.includes('Note:'));
    assert.deepEqual(listing.price, { amount: 115, currency: 'chaos', type: '~b/o' });
    assert.equal(listing.seller, 'SellerA');
    assert.equal(listing.rarity, 'Rare');
    assert.equal(listing.identified, true);
    assert.equal(listing.corrupted, false);
    assert.deepEqual(listing.statIds, ['explicit.stat_3299347043', 'explicit.stat_2923486259', 'crafted.stat_2250533757'], 'own mod lines, not implicits');
});

test('fetch keeps the requested order and reports null or absent entries as missing', () => {
    const fetched: FetchResponse = readFetchResponse({ result: [listingJson('b', 1, 'divine'), null, listingJson('a', 2, 'chaos')] }, ['a', 'gone', 'b', 'absent']);
    assert.deepEqual(fetched.listings.map((l: TradeListing) => l.id), ['a', 'b']);
    assert.deepEqual(fetched.missing, ['gone', 'absent']);
});

test('a malformed listing is skipped with its path; the rest of the batch is kept', () => {
    const fetched: FetchResponse = readFetchResponse({ result: [listingJson('a', 2, 'chaos'), { id: 'x', listing: {}, item: { baseType: 'B', extended: {} } }, listingJson('b', 1, 'divine')] }, ['a', 'x', 'b']);
    assert.deepEqual(fetched.listings.map((l: TradeListing) => l.id), ['a', 'b']);
    assert.deepEqual(fetched.missing, []);
    assert.equal(fetched.malformed.length, 1);
    assert.equal(fetched.malformed[0]?.id, 'x');
    assert.match(fetched.malformed[0]?.error ?? '', /fetch\.result\[1\]\.item\.extended\.text/);
});

test('reads a search response', () => {
    assert.deepEqual(readSearchResponse({ id: 'q1', complexity: 154, result: ['a', 'b'], total: 449 }), { id: 'q1', ids: ['a', 'b'], total: 449, inexact: false, complexity: 154 });
    assert.deepEqual(readSearchResponse({ id: 'q2', complexity: null, result: [], total: 0, inexact: true }), { id: 'q2', ids: [], total: 0, inexact: true, complexity: undefined });
});

test('reads the site error body', () => {
    assert.deepEqual(readSiteError({ error: { code: 2, message: 'Query is too complex. Please reduce the amount of filters used.' } }), {
        code: 2,
        message: 'Query is too complex. Please reduce the amount of filters used.',
    });
    assert.equal(readSiteError({ result: [] }), undefined);
});

test('stripTokens drops whisper and hideout tokens at any depth', () => {
    assert.deepEqual(stripTokens({ a: [{ whisper_token: 'x', hideout_token: 'y', keep: 1 }], whisper: 'w' }), { a: [{ keep: 1 }] });
});

// The spike's V19 recording: 56 real fetch responses (560 listings, rare/magic/normal boots, Covens, 21 Nov).
// It has seller names in it, so it stays in app data and isn't committed.
const V19_DIR: string = join(process.env['APPDATA'] ?? '', 'poe-signin-spike', 'v19');
const v19Files: readonly string[] = existsSync(V19_DIR) ? readdirSync(V19_DIR).filter((f: string) => f.endsWith('-raw.json')) : [];

test('every recorded V19 fetch response parses', { skip: v19Files.length === 0 ? `no recording in ${V19_DIR}` : false }, () => {
    let listings: number = 0;
    const rarities: Map<string, number> = new Map<string, number>();
    for (const file of v19Files) {
        const raw: unknown = JSON.parse(readFileSync(join(V19_DIR, file), 'utf8'));
        assert.ok(typeof raw === 'object' && raw !== null && 'fetch' in raw && Array.isArray(raw.fetch));
        for (const call of raw.fetch as readonly unknown[]) {
            assert.ok(typeof call === 'object' && call !== null && 'ids' in call && 'json' in call && Array.isArray(call.ids));
            const ids: string[] = call.ids.filter((id: unknown): id is string => typeof id === 'string');
            const fetched: FetchResponse = readFetchResponse(call.json, ids);
            assert.equal(fetched.missing.length, 0);
            for (const l of fetched.listings) {
                listings++;
                rarities.set(l.rarity, (rarities.get(l.rarity) ?? 0) + 1);
                assert.ok(/^Item Class: .+\nRarity: /.test(l.text), `listing ${l.id} text starts oddly`);
                assert.ok(!l.text.includes('Note:') && !l.text.includes('\r'), `listing ${l.id} kept its note or CRs`);
                assert.ok(l.price !== undefined && l.price.amount > 0, `listing ${l.id} has no price`);
            }
        }
    }
    assert.equal(listings, 560);
    assert.equal(rarities.get('Rare'), 482);
});
