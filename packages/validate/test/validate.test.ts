import assert from 'node:assert/strict';
import { test } from 'node:test';
import { array, luaArray, string, ValidationError } from '../src/index.ts';

test('array is strict: an empty object is an error, not an empty list', () => {
    assert.deepEqual(array(['a', 'b'], 'x', string), ['a', 'b']);
    assert.deepEqual(array([], 'x', string), []);
    assert.throws(
        () => array({}, 'search.result', string),
        (error: unknown) => {
            return error instanceof ValidationError && error.message === 'search.result: expected an array, got object';
        },
    );
    assert.throws(() => array(undefined, 'x', string), ValidationError);
});

test("luaArray (engine messages) reads Lua's empty table {} as [], and nothing else", () => {
    assert.deepEqual(luaArray({}, 'x', string), []);
    assert.deepEqual(luaArray(['a'], 'x', string), ['a']);
    assert.throws(() => luaArray({ a: 1 }, 'x', string), ValidationError);
    assert.throws(() => luaArray(null, 'x', string), ValidationError);
    assert.throws(() => luaArray([1], 'x', string), /x\[0\]: expected a string/);
});
