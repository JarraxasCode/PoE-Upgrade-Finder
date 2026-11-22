import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoute, routeHash } from '../src/routes.ts';

test('hashes map to routes; anything else is Search', () => {
    assert.equal(parseRoute('#/settings'), 'settings');
    assert.equal(parseRoute('#/run'), 'run');
    assert.equal(parseRoute('#settings'), 'settings');
    assert.equal(parseRoute('#/run/abc?x=1'), 'run');
    assert.equal(parseRoute(''), 'search');
    assert.equal(parseRoute('#/nope'), 'search');
    assert.equal(parseRoute('#/constructor'), 'search');
});

test('routeHash round-trips', () => {
    assert.equal(parseRoute(routeHash('settings')), 'settings');
});
