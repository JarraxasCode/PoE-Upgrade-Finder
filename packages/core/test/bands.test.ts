import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandSearches, chaosEquivalent, priceBands, splitDepth } from '../src/bands.ts';
import type { PriceBand } from '../src/bands.ts';

test('bands from a 300c budget: ≤1c, 1–33, 33–100, 100–300, and 300–375 over budget', () => {
    const bands: PriceBand[] = priceBands(300);
    assert.deepEqual(bands.map((b: PriceBand) => [b.id, b.minChaos, b.maxChaos, b.role]), [
        ['band-1', undefined, 1, 'main'],
        ['band-2', 1, 33, 'main'],
        ['band-3', 33, 100, 'main'],
        ['band-4', 100, 300, 'main'],
        ['over', 300, 375, 'over'],
    ]);
    assert.equal(bands[1]?.label, '1c to 33c');
    assert.equal(bands[4]?.label, '300c to 375c (slightly over budget)');
});

test('small budgets drop the edges that fall below 1c or meet the budget', () => {
    assert.deepEqual(priceBands(5).map((b: PriceBand) => [b.minChaos, b.maxChaos]), [[undefined, 1], [1, 1.67], [1.67, 5], [5, 6.25]]);
    assert.deepEqual(priceBands(0.5).map((b: PriceBand) => [b.minChaos, b.maxChaos]), [[undefined, 0.5], [0.5, 0.63]]);
    assert.deepEqual(priceBands(9, { overFactor: 0 }).map((b: PriceBand) => [b.minChaos, b.maxChaos]), [[undefined, 1], [1, 3], [3, 9]]);
    assert.throws(() => priceBands(0), RangeError);
});

test('each band is a chaos search, plus a divine one when its top reaches 1 divine', () => {
    const [b1, b2, b3, b4] = priceBands(600);
    assert.ok(b1 && b2 && b3 && b4);
    assert.deepEqual(bandSearches(b1, 200), [{ bandId: 'band-1', option: 'chaos', price: { max: 1, option: 'chaos' } }]);
    assert.equal(bandSearches(b3, 200).length, 2, '66.67–200c reaches 1 div');
    assert.deepEqual(bandSearches(b4, 207.9)[1], { bandId: 'band-4', option: 'divine', price: { min: 0.96, max: 2.89, option: 'divine' } });
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
    assert.deepEqual(splitDepth(100, [{ total: 449, available: 100 }, { total: 10000, available: 100 }]), [10, 90]);
    assert.deepEqual(splitDepth(100, [{ total: 5000, available: 100 }, { total: 5000, available: 100 }]), [50, 50]);
    // The divine search only has 30 ids: the chaos one gets the rest.
    assert.deepEqual(splitDepth(100, [{ total: 9000, available: 100 }, { total: 9000, available: 30 }]), [70, 30]);
    // Neither can fill the depth.
    assert.deepEqual(splitDepth(100, [{ total: 12, available: 12 }, { total: 20, available: 20 }]), [12, 20]);
    assert.deepEqual(splitDepth(100, [{ total: 0, available: 0 }, { total: 300, available: 100 }]), [0, 100]);
    assert.deepEqual(splitDepth(20, [{ total: 100, available: 100 }, { total: 9900, available: 100 }]), [10, 10]);
    assert.deepEqual(splitDepth(50, [{ total: 100, available: 100 }]), [50]);
    assert.deepEqual(splitDepth(100, []), []);
});

test('a min price drops the bands under it; the first band starts at it', () => {
    // 200 div at 213c: budget 42,600c, min 100 div (21,300c). B/9 and B/3 are under the min, so one band, then over.
    const bands: PriceBand[] = priceBands(42600, { minChaos: 21300 });
    assert.deepEqual(bands.map((b: PriceBand) => [b.minChaos, b.maxChaos, b.role]), [[21300, 42600, 'main'], [42600, 53250, 'over']]);
    assert.equal(bands[0]?.label, '21300c to 42600c');
    assert.deepEqual(priceBands(300, { minChaos: 50 }).map((b: PriceBand) => [b.minChaos, b.maxChaos]), [[50, 100], [100, 300], [300, 375]]);
    assert.throws(() => priceBands(300, { minChaos: 300 }), RangeError);
});

test('edges are whole chaos from 10c up', () => {
    assert.deepEqual(priceBands(2130).map((b: PriceBand) => b.label), ['up to 1c', '1c to 237c', '237c to 710c', '710c to 2130c', '2130c to 2663c (slightly over budget)']);
});
