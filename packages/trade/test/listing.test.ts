import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readFetchResponse, readSearchResponse, readSiteError, stripNote, stripTokens } from '../src/listing.ts';
import type { FetchResponse, TradeListing } from '../src/listing.ts';
import { listingJson } from './helpers.ts';

test('stripNote removes the trailing Note section and blank lines', () => {
    assert.equal(
        stripNote('Rarity: Rare\nX\n--------\n+1 to Life\n--------\nNote: ~b/o 5 chaos\n'),
        'Rarity: Rare\nX\n--------\n+1 to Life',
    );
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
    assert.deepEqual(
        listing.statIds,
        ['explicit.stat_3299347043', 'explicit.stat_2923486259', 'crafted.stat_2250533757'],
        'own mod lines, not implicits',
    );
});

test('stat lines: the signed-in line objects carry their own hash; plain strings match extended.hashes by position', () => {
    const signedIn: unknown = {
        ...(listingJson('s', 1, 'chaos') as Record<string, unknown>),
    };
    const item = (signedIn as { item: Record<string, unknown> }).item;
    item['implicitMods'] = [{ description: '+20 to Dexterity', domain: 'implicit', hash: 'stat.implicit.stat_3261801346' }];
    item['explicitMods'] = [{ description: '+14% to [ItemRarity|Item Rarity]', domain: 'explicit', hash: 'stat.explicit.stat_3917489142' }];
    item['craftedMods'] = [{ description: '15% increased Movement Speed', domain: 'crafted', hash: 'stat.crafted.stat_2250533757' }];
    const a: TradeListing | undefined = readFetchResponse({ result: [signedIn] }, ['s']).listings[0];
    assert.ok(a);
    assert.deepEqual(a.statLines, [
        { statId: 'implicit.stat_3261801346', kind: 'implicit', text: '+20 to Dexterity' },
        { statId: 'explicit.stat_3917489142', kind: 'explicit', text: '+14% to Item Rarity' },
        { statId: 'crafted.stat_2250533757', kind: 'crafted', text: '15% increased Movement Speed' },
    ]);

    const plain: unknown = listingJson('p', 1, 'chaos');
    const pitem = (plain as { item: Record<string, unknown> }).item;
    pitem['explicitMods'] = ['+40 to maximum Life', '+30% to Chaos Resistance'];
    pitem['implicitMods'] = ['+20 to Dexterity', 'one line too many'];
    const b: TradeListing | undefined = readFetchResponse({ result: [plain] }, ['p']).listings[0];
    assert.ok(b);
    assert.deepEqual(
        b.statLines,
        [
            { statId: 'explicit.stat_3299347043', kind: 'explicit', text: '+40 to maximum Life' },
            { statId: 'explicit.stat_2923486259', kind: 'explicit', text: '+30% to Chaos Resistance' },
        ],
        'implicits left out: two lines against one hash',
    );
});

test('fetch keeps the requested order and reports null or absent entries as missing', () => {
    const fetched: FetchResponse = readFetchResponse({ result: [listingJson('b', 1, 'divine'), null, listingJson('a', 2, 'chaos')] }, [
        'a',
        'gone',
        'b',
        'absent',
    ]);
    assert.deepEqual(
        fetched.listings.map((l: TradeListing) => l.id),
        ['a', 'b'],
    );
    assert.deepEqual(fetched.missing, ['gone', 'absent']);
});

test('a malformed listing is skipped with its path; the rest of the batch is kept', () => {
    const fetched: FetchResponse = readFetchResponse(
        {
            result: [
                listingJson('a', 2, 'chaos'),
                { id: 'x', listing: {}, item: { baseType: 'B', extended: {} } },
                listingJson('b', 1, 'divine'),
            ],
        },
        ['a', 'x', 'b'],
    );
    assert.deepEqual(
        fetched.listings.map((l: TradeListing) => l.id),
        ['a', 'b'],
    );
    assert.deepEqual(fetched.missing, []);
    assert.equal(fetched.malformed.length, 1);
    assert.equal(fetched.malformed[0]?.id, 'x');
    assert.match(fetched.malformed[0]?.error ?? '', /fetch\.result\[1\]\.item\.extended\.text/);
});

test('reads a search response', () => {
    assert.deepEqual(readSearchResponse({ id: 'q1', complexity: 154, result: ['a', 'b'], total: 449 }), {
        id: 'q1',
        ids: ['a', 'b'],
        total: 449,
        inexact: false,
        complexity: 154,
    });
    assert.deepEqual(readSearchResponse({ id: 'q2', complexity: null, result: [], total: 0, inexact: true }), {
        id: 'q2',
        ids: [],
        total: 0,
        inexact: true,
        complexity: undefined,
    });
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

// The spike's V19 recording: 56 real fetch responses (560 listings, rare/magic/normal boots, Covens, 21 Nov),
// with seller names replaced (tools/fixtures/make-fixtures.ts). It lives in the private repo's test/fixtures/,
// which isn't published, so the test skips in the public copy.
const V19_FILE: string = fileURLToPath(new URL('../../../test/fixtures/trade/v19-boots-raw.json', import.meta.url));

test('every recorded V19 fetch response parses', { skip: existsSync(V19_FILE) ? false : `no fixture at ${V19_FILE}` }, () => {
    let listings: number = 0;
    const rarities: Map<string, number> = new Map<string, number>();
    {
        const raw: unknown = JSON.parse(readFileSync(V19_FILE, 'utf8'));
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
