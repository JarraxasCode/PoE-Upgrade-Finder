import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    applyWeightEdits,
    effectiveWeight,
    MAX_WEIGHT_PCT,
    shownPercent,
    topWeight,
    weightCounts,
    withOn,
    withPercent,
} from '../src/index.ts';
import type { WeightEdit, WeightEdits } from '../src/index.ts';

const W = [
    { statId: 'a', weight: 10 },
    { statId: 'b', weight: 5 },
    { statId: 'c', weight: 1 },
    { statId: 'inv', weight: -4 },
];

test('edits: off drops a stat, a factor scales PoB weight, unnamed stats and inverted signs stay', () => {
    const edits: WeightEdits = { b: { off: true, factor: 3 }, c: { factor: 4 }, inv: { factor: 0.5 }, zz: { factor: 3 } };
    assert.deepEqual(applyWeightEdits(W, edits), [
        { statId: 'a', weight: 10 },
        { statId: 'c', weight: 4 },
        { statId: 'inv', weight: -2 },
    ]);
    assert.deepEqual(applyWeightEdits(W, undefined), W);
    assert.equal(effectiveWeight(5, { off: true }), undefined);
});

test('an edit is relative: PoB weights regenerated ten times bigger keep the same share of the top (#111)', () => {
    const edit: WeightEdit | undefined | 'refused' = withPercent(undefined, 50, 5, topWeight(W));
    assert.equal(edit, undefined);
    const half: WeightEdit | undefined | 'refused' = withPercent(undefined, 25, 5, topWeight(W));
    assert.ok(half !== undefined && half !== 'refused');
    const bigger = W.map((w) => ({ ...w, weight: w.weight * 10 }));
    assert.equal(shownPercent(50, half, topWeight(bigger)), 25);
});

test("typing back PoB's own % or the % already shown records nothing new", () => {
    const top: number = topWeight(W);
    // PoB's 1 of 10 shows as 10%.
    assert.equal(withPercent(undefined, 10, 1, top), undefined);
    assert.equal(withPercent({ factor: 4 }, 10, 1, top), undefined);
    assert.deepEqual(withPercent({ factor: 4 }, 40, 1, top), { factor: 4 });
    // Off stays off when the factor changes.
    assert.deepEqual(withPercent({ off: true }, 20, 1, top), { factor: 2, off: true });
});

test('the review refuses 0, negative and non-numbers, and caps at the max %', () => {
    const top: number = topWeight(W);
    assert.equal(withPercent(undefined, 0, 1, top), 'refused');
    assert.equal(withPercent(undefined, -20, 1, top), 'refused');
    assert.equal(withPercent(undefined, Number.NaN, 1, top), 'refused');
    assert.deepEqual(withPercent(undefined, 5000, 1, top), { factor: (MAX_WEIGHT_PCT / 100) * 10 });
});

test('inverted stats show by size, and the top counts them by size', () => {
    assert.equal(
        topWeight([
            { statId: 'x', weight: -8 },
            { statId: 'y', weight: 2 },
        ]),
        8,
    );
    assert.equal(shownPercent(-4, undefined, 10), 40);
    assert.deepEqual(withPercent(undefined, 80, -4, 10), { factor: 2 });
    assert.equal(topWeight([]), 1);
});

test('on and off keep the factor; an empty edit is no edit', () => {
    assert.deepEqual(withOn({ factor: 2 }, false), { factor: 2, off: true });
    assert.deepEqual(withOn({ factor: 2, off: true }, true), { factor: 2 });
    assert.equal(withOn({ off: true }, true), undefined);
    assert.deepEqual(withOn(undefined, false), { off: true });
});

test('counts leave out what the plan prunes; reweighted means on with a factor', () => {
    const edits: WeightEdits = { a: { off: true }, b: { factor: 2 }, c: { factor: 2, off: true }, inv: { off: true } };
    assert.deepEqual(weightCounts(W, edits, new Set(['inv'])), { searchable: 3, on: 1, off: 2, reweighted: 1 });
});
