import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEngineNumber, isEngineValue, toNumber } from '../src/index.ts';

test('finite numbers pass through', () => {
    assert.equal(toNumber(116448.2583), 116448.2583);
    assert.equal(toNumber(0), 0);
});

test('non-finite strings decode', () => {
    assert.equal(toNumber('Infinity'), Number.POSITIVE_INFINITY);
    assert.equal(toNumber('-Infinity'), Number.NEGATIVE_INFINITY);
    assert.ok(Number.isNaN(toNumber('NaN')));
});

test('guards reject other strings and accept flags only as values', () => {
    assert.equal(isEngineNumber('inf'), false);
    assert.equal(isEngineNumber('12'), false);
    assert.equal(isEngineNumber(true), false);
    assert.equal(isEngineValue(true), true);
    assert.equal(isEngineValue(null), false);
});
