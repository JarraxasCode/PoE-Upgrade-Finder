import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gainOf, generatorWeights, percentChange } from '../src/index.ts';
import type { GainStats } from '../src/index.ts';

const stats = (damage: number, ehp: number): GainStats => ({ damage: damage, values: { TotalEHP: ehp } });

test('percent change, including the undefined cases', () => {
    assert.equal(percentChange(200, 210), 5.000000000000004);
    assert.equal(percentChange(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), 0);
    assert.equal(percentChange(0, 0), 0);
    assert.ok(Number.isNaN(percentChange(0, 5)));
    assert.ok(Number.isNaN(percentChange(Number.POSITIVE_INFINITY, 5)));
    assert.equal(percentChange(5, Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
});

test('gain blends DPS and EHP change', () => {
    // V5's Dragon Slippers on RF: DPS -0.186%, EHP -3.254%
    const g = gainOf(stats(2279866.348, 116448.2583), stats(2275622.834, 112658.6259));
    assert.ok(Math.abs(g.dpsPct - -0.18613) < 1e-4);
    assert.ok(Math.abs(g.ehpPct - -3.25439) < 1e-4);
    assert.ok(Math.abs(g.gain - (g.dpsPct + g.ehpPct) / 2) < 1e-12);
    assert.equal(gainOf(stats(100, 100), stats(110, 50), 1).gain, 10.000000000000009);
});

test('a zero-weight side is ignored even with no percentage', () => {
    assert.equal(gainOf(stats(0, 100), stats(5, 110), 0).gain, 10.000000000000009);
    assert.ok(Number.isNaN(gainOf(stats(0, 100), stats(5, 110), 0.5).gain));
});

test('blend checks and generator weights', () => {
    assert.throws(() => gainOf(stats(1, 1), stats(1, 1), 1.5), RangeError);
    assert.deepEqual(generatorWeights(0.25), { dpsWeight: 0.25, ehpWeight: 0.75 });
});
