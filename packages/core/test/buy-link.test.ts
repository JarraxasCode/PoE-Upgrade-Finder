import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buyLink, isTradeSiteUrl } from '../src/buy-link.ts';

function query(link: string | undefined): unknown {
    assert.ok(link !== undefined && isTradeSiteUrl(link));
    return JSON.parse(new URL(link).searchParams.get('q') ?? '');
}

test('a buy link pins the listing: seller, base, exact price and item level', () => {
    const link: string | undefined = buyLink('Covens of Umbra', {
        seller: 'exampleseller#1234',
        baseType: 'Amethyst Ring',
        itemLevel: 83,
        price: { amount: 170, currency: 'chaos' },
    });
    assert.equal(new URL(link ?? '').pathname, '/trade/search/Covens%20of%20Umbra');
    assert.deepEqual(query(link), {
        query: {
            status: { option: 'any' },
            type: 'Amethyst Ring',
            stats: [{ type: 'and', filters: [] }],
            filters: {
                trade_filters: { filters: { account: { input: 'exampleseller#1234' }, price: { min: 170, max: 170, option: 'chaos' } } },
                misc_filters: { filters: { ilvl: { min: 83, max: 83 } } },
            },
        },
    });
});

test('the item mod lines are required, presence only', () => {
    const q = query(
        buyLink('Covens', { seller: 'S', baseType: 'Amethyst Ring', statIds: ['explicit.stat_2144192055', 'crafted.stat_3299347043'] }),
    );
    assert.deepEqual((q as { query: { stats: unknown } }).query.stats, [
        { type: 'and', filters: [{ id: 'explicit.stat_2144192055' }, { id: 'crafted.stat_3299347043' }] },
    ]);
});

test('without a price in chaos or divines, or an item level, those filters are left out', () => {
    assert.deepEqual(query(buyLink('Covens', { seller: 'S', baseType: 'X', price: { amount: 2, currency: 'exalted' } })), {
        query: {
            status: { option: 'any' },
            type: 'X',
            stats: [{ type: 'and', filters: [] }],
            filters: { trade_filters: { filters: { account: { input: 'S' } } } },
        },
    });
    assert.equal(buyLink('Covens', { seller: undefined, baseType: 'X' }), undefined);
});

test('only https www.pathofexile.com/trade/ URLs may be opened', () => {
    assert.equal(isTradeSiteUrl('https://www.pathofexile.com/trade/search/Covens'), true);
    assert.equal(isTradeSiteUrl('https://www.pathofexile.com/forum'), false);
    assert.equal(isTradeSiteUrl('http://www.pathofexile.com/trade/'), false);
    assert.equal(isTradeSiteUrl('https://evil.example/trade/'), false);
});
