import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandSearches, budgetOf, chaosEquivalent, priceBands, priceRole, splitDepth } from '../src/bands.ts';
import type { BandSearch, PriceBand } from '../src/bands.ts';

test('bands from a 300c budget: ≤1c, 1–33, 33–100, 100–300, and 300–375 over budget', () => {
    const bands: PriceBand[] = priceBands(300);
    assert.deepEqual(
        bands.map((b: PriceBand) => [b.id, b.minChaos, b.maxChaos, b.role]),
        [
            ['band-1', undefined, 1, 'main'],
            ['band-2', 1, 33, 'main'],
            ['band-3', 33, 100, 'main'],
            ['band-4', 100, 300, 'main'],
            ['over', 300, 375, 'over'],
        ],
    );
    assert.equal(bands[1]?.label, '1c to 33c');
    assert.equal(bands[4]?.label, '300c to 375c (slightly over budget)');
});

/** Each band's searches as [band id, option, min, max] at the given divine rate. */
function searchEdges(budget: number, chaosPerDivine: number): (string | number | undefined)[][] {
    return priceBands(budget).flatMap((b: PriceBand) =>
        bandSearches(b, chaosPerDivine).map((s: BandSearch) => [s.bandId, s.option, s.price.min, s.price.max]),
    );
}

// #57: listings are priced in whole chaos, so 1c to 1.67c (5c budget) and 1c to 1.11c (10c) only held the 1c
// listings the "up to 1c" band already had: the same search twice and an empty band. Those edges merge into
// the next band, and a whole lower edge is searched from 0.01c above it.
test('a 5c budget: up to 1c, 1c to 5c, over 5c to 6.25c (was 1c to 1.67c and 1.67c to 5c)', () => {
    assert.deepEqual(searchEdges(5, 185.7), [
        ['band-1', 'chaos', undefined, 1],
        ['band-2', 'chaos', 1.01, 5],
        ['over', 'chaos', 5.01, 6.25],
    ]);
    assert.deepEqual(
        priceBands(5).map((b: PriceBand) => b.label),
        ['up to 1c', '1c to 5c', '5c to 6.25c (slightly over budget)'],
    );
});

test('a 10c budget: up to 1c, 1c to 3.33c, 3.33c to 10c, over 10c to 13c (was 1c to 1.11c and 1.11c to 3.33c)', () => {
    assert.deepEqual(searchEdges(10, 185.7), [
        ['band-1', 'chaos', undefined, 1],
        ['band-2', 'chaos', 1.01, 3.33],
        ['band-3', 'chaos', 3.33, 10],
        ['over', 'chaos', 10.01, 13],
    ]);
});

test('a 25c budget keeps its four bands; only the whole lower edges move up 0.01c', () => {
    assert.deepEqual(searchEdges(25, 185.7), [
        ['band-1', 'chaos', undefined, 1],
        ['band-2', 'chaos', 1.01, 2.78],
        ['band-3', 'chaos', 2.78, 8.33],
        ['band-4', 'chaos', 8.33, 25],
        ['over', 'chaos', 25.01, 31],
    ]);
});

test('a large budget keeps its edges and divine searches; the chaos searches skip the shared whole edge', () => {
    // 300c at 207.9c/div, as in a recorded Boots run. An exclusive divine min rounds up (#111): the run sent 0.48 and 1.44.
    assert.deepEqual(searchEdges(300, 207.9), [
        ['band-1', 'chaos', undefined, 1],
        ['band-2', 'chaos', 1.01, 33],
        ['band-3', 'chaos', 33.01, 100],
        ['band-4', 'chaos', 100.01, 300],
        ['band-4', 'divine', 0.49, 1.45],
        ['over', 'chaos', 300.01, 375],
        ['over', 'divine', 1.45, 1.81],
    ]);
});

test('a whole-divine budget: the over band starts a cent above it, and roles follow the price (#111)', () => {
    // 300c at 150c/div is exactly 2 div: the over band's divine search used to start at 2 and fetch 2-div listings too.
    assert.deepEqual(
        searchEdges(300, 150).filter((e) => e[1] === 'divine'),
        [
            ['band-4', 'divine', 0.67, 2],
            ['over', 'divine', 2.01, 2.5],
        ],
    );
    const bands: PriceBand[] = priceBands(300);
    const over: PriceBand | undefined = bands.find((b: PriceBand) => b.role === 'over');
    const top: PriceBand | undefined = bands.find((b: PriceBand) => b.id === 'band-4');
    assert.ok(over !== undefined && top !== undefined);
    assert.equal(budgetOf(bands), 300);
    // Whichever band fetched it: at the budget is in budget, 1c over is over.
    assert.equal(priceRole(300, over, 300), 'main');
    assert.equal(priceRole(301, top, 300), 'over');
    // No chaos price: the band's role.
    assert.equal(priceRole(undefined, over, 300), 'over');
    assert.equal(budgetOf([]), undefined);
});

test('a band with no whole chaos price of its own merges into its neighbour', () => {
    // 2c: 1c to 2c holds 2c; the over band (2c to 2.5c) holds none and is left out.
    assert.deepEqual(
        priceBands(2).map((b: PriceBand) => [b.minChaos, b.maxChaos, b.role]),
        [
            [undefined, 1, 'main'],
            [1, 2, 'main'],
        ],
    );
    // 1.5c: nothing whole between 1c and 1.5c, so the budget band takes the 1c edge's place.
    assert.deepEqual(
        priceBands(1.5).map((b: PriceBand) => [b.minChaos, b.maxChaos]),
        [[undefined, 1.5]],
    );
    // A min price is part of its band: 2c to 2.78c holds 2c.
    assert.deepEqual(
        priceBands(25, { minChaos: 2 }).map((b: PriceBand) => [b.minChaos, b.maxChaos, b.minExclusive]),
        [
            [2, 2.78, false],
            [2.78, 8.33, true],
            [8.33, 25, true],
            [25, 31, true],
        ],
    );
    const [first] = priceBands(25, { minChaos: 2 });
    assert.ok(first);
    assert.deepEqual(bandSearches(first, 185.7)[0]?.price, { min: 2, max: 2.78, option: 'chaos' });
});

test('small budgets drop the edges that fall below 1c or meet the budget', () => {
    assert.deepEqual(
        priceBands(0.5).map((b: PriceBand) => [b.minChaos, b.maxChaos]),
        [[undefined, 0.5]],
    );
    assert.deepEqual(
        priceBands(9, { overFactor: 0 }).map((b: PriceBand) => [b.minChaos, b.maxChaos]),
        [
            [undefined, 1],
            [1, 3],
            [3, 9],
        ],
    );
    assert.throws(() => priceBands(0), RangeError);
});

test('each band is a chaos search, plus a divine one when its top reaches 1 divine', () => {
    const [b1, b2, b3, b4] = priceBands(600);
    assert.ok(b1 && b2 && b3 && b4);
    assert.deepEqual(bandSearches(b1, 200), [{ bandId: 'band-1', option: 'chaos', price: { max: 1, option: 'chaos' } }]);
    assert.equal(bandSearches(b3, 200).length, 2, '66.67–200c reaches 1 div');
    assert.deepEqual(bandSearches(b4, 207.9)[1], { bandId: 'band-4', option: 'divine', price: { min: 0.97, max: 2.89, option: 'divine' } });
    assert.equal(bandSearches(b4, undefined).length, 1, 'no rate: chaos only');
});

test('chaos equivalents: chaos as is, divines at the rate, other currencies undefined', () => {
    assert.equal(chaosEquivalent({ amount: 30, currency: 'chaos' }, 200), 30);
    assert.equal(chaosEquivalent({ amount: 1.5, currency: 'divine' }, 200), 300);
    assert.equal(chaosEquivalent({ amount: 1.5, currency: 'divine' }, undefined), undefined);
    assert.equal(chaosEquivalent({ amount: 2, currency: 'exalted' }, 200), undefined);
    assert.equal(chaosEquivalent(undefined, 200), undefined);
});

test('depth split: in proportion to totals, at least 10 each, capped by the ids returned', () => {
    assert.deepEqual(
        splitDepth(100, [
            { total: 449, available: 100 },
            { total: 10000, available: 100 },
        ]),
        [10, 90],
    );
    assert.deepEqual(
        splitDepth(100, [
            { total: 5000, available: 100 },
            { total: 5000, available: 100 },
        ]),
        [50, 50],
    );
    // The divine search only has 30 ids: the chaos one gets the rest.
    assert.deepEqual(
        splitDepth(100, [
            { total: 9000, available: 100 },
            { total: 9000, available: 30 },
        ]),
        [70, 30],
    );
    // Neither can fill the depth.
    assert.deepEqual(
        splitDepth(100, [
            { total: 12, available: 12 },
            { total: 20, available: 20 },
        ]),
        [12, 20],
    );
    assert.deepEqual(
        splitDepth(100, [
            { total: 0, available: 0 },
            { total: 300, available: 100 },
        ]),
        [0, 100],
    );
    assert.deepEqual(
        splitDepth(20, [
            { total: 100, available: 100 },
            { total: 9900, available: 100 },
        ]),
        [10, 10],
    );
    assert.deepEqual(splitDepth(50, [{ total: 100, available: 100 }]), [50]);
    assert.deepEqual(splitDepth(100, []), []);
});

test('a min price drops the bands under it; the first band starts at it', () => {
    // 200 div at 213c: budget 42,600c, min 100 div (21,300c). B/9 and B/3 are under the min, so one band, then over.
    const bands: PriceBand[] = priceBands(42600, { minChaos: 21300 });
    assert.deepEqual(
        bands.map((b: PriceBand) => [b.minChaos, b.maxChaos, b.role]),
        [
            [21300, 42600, 'main'],
            [42600, 53250, 'over'],
        ],
    );
    assert.equal(bands[0]?.label, '21300c to 42600c');
    assert.deepEqual(
        priceBands(300, { minChaos: 50 }).map((b: PriceBand) => [b.minChaos, b.maxChaos]),
        [
            [50, 100],
            [100, 300],
            [300, 375],
        ],
    );
    assert.throws(() => priceBands(300, { minChaos: 300 }), RangeError);
});

test('edges are whole chaos from 10c up', () => {
    assert.deepEqual(
        priceBands(2130).map((b: PriceBand) => b.label),
        ['up to 1c', '1c to 237c', '237c to 710c', '710c to 2130c', '2130c to 2663c (slightly over budget)'],
    );
});
