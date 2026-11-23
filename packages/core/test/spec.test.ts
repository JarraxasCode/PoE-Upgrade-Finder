import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyWeightEdits } from '../src/spec.ts';

test('weight edits: 0 drops a stat, a number replaces its weight, unnamed stats keep theirs', () => {
    const w = [
        { statId: 'a', weight: 10 },
        { statId: 'b', weight: 5 },
        { statId: 'c', weight: 1 },
    ];
    assert.deepEqual(applyWeightEdits(w, { b: 0, c: 4, zz: 3 }), [
        { statId: 'a', weight: 10 },
        { statId: 'c', weight: 4 },
    ]);
    assert.deepEqual(applyWeightEdits(w, undefined), w);
});
