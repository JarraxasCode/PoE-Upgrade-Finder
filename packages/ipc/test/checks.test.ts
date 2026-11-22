import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '@poe-upgrade-finder/validate';
import { METHOD_RESULTS, parseInvokeRequest, parseInvokeResponse, parseMainEvent, readRunRequest } from '../src/index.ts';

test('a known method with its params passes; params default to none', () => {
    assert.deepEqual(parseInvokeRequest({ method: 'app.info', params: {} }), { method: 'app.info', params: {} });
    assert.deepEqual(parseInvokeRequest({ method: 'app.info' }), { method: 'app.info', params: {} });
});

test('unknown methods, inherited names and stray params are refused', () => {
    assert.throws(() => parseInvokeRequest({ method: 'fs.readFile', params: {} }), ValidationError);
    assert.throws(() => parseInvokeRequest({ method: 'toString', params: {} }), ValidationError);
    assert.throws(() => parseInvokeRequest({ method: 'app.info', params: { path: 'C:/' } }), ValidationError);
    assert.throws(() => parseInvokeRequest('app.info'), ValidationError);
    assert.throws(() => parseInvokeRequest({ method: 3 }), ValidationError);
});

test('response envelopes: ok carries the result, errors are checked', () => {
    assert.deepEqual(parseInvokeResponse({ ok: true, result: 5 }), { ok: true, result: 5 });
    assert.deepEqual(parseInvokeResponse({ ok: false, error: { code: 'failed', message: 'no' } }), { ok: false, error: { code: 'failed', message: 'no' } });
    assert.throws(() => parseInvokeResponse({ ok: false, error: { code: 'weird', message: 'no' } }), ValidationError);
    assert.throws(() => parseInvokeResponse(null), ValidationError);
});

test('results are checked per method', () => {
    const info = { appVersion: '0.1.0', electron: '45.4.1', chromium: '156', node: '24', pobVersion: '2.68.1', canRemove: false };
    assert.deepEqual(METHOD_RESULTS['app.info'](info, 'r'), info);
    assert.throws(() => METHOD_RESULTS['app.info']({ ...info, node: 24 }, 'r'), ValidationError);
});

test('events: notices pass, unknown kinds are dropped, bad notices throw', () => {
    assert.deepEqual(parseMainEvent({ kind: 'notice', level: 'warn', message: 'x' }), { kind: 'notice', level: 'warn', message: 'x' });
    assert.equal(parseMainEvent({ kind: 'later' }), undefined);
    assert.equal(parseMainEvent(7), undefined);
    assert.throws(() => parseMainEvent({ kind: 'notice', level: 'loud', message: 'x' }), ValidationError);
});

test('requests: build ids must be plain relative .xml paths', () => {
    const ok = parseInvokeRequest({ method: 'build.select', params: { buildId: 'Covens of Umbra/Example RF.xml', target: 'skill:6.1' } });
    assert.deepEqual(ok.params, { buildId: 'Covens of Umbra/Example RF.xml', target: 'skill:6.1' });
    for (const bad of ['../x.xml', 'C:/x.xml', '/x.xml', 'a\\b.xml', 'a\b.xml', 'a\u0000.xml', 'a//b.xml', 'x.txt', '']) {
        assert.throws(() => parseInvokeRequest({ method: 'build.select', params: { buildId: bad, target: null } }), ValidationError, bad);
    }
    assert.throws(() => parseInvokeRequest({ method: 'build.select', params: { buildId: 'a.xml', target: 'skill:x' } }), ValidationError);
});

test('requests: settings are checked field by field', () => {
    const settings = { league: 'Covens', listing: 'securable', depth: 'thorough', buildsDir: null, debug: false };
    assert.deepEqual(parseInvokeRequest({ method: 'settings.save', params: { settings: settings } }).params, { settings: settings });
    assert.throws(() => parseInvokeRequest({ method: 'settings.save', params: { settings: { ...settings, depth: 'deep' } } }), ValidationError);
    assert.throws(() => parseInvokeRequest({ method: 'settings.save', params: { settings: { ...settings, league: ' ' } } }), ValidationError);
    assert.throws(() => parseInvokeRequest({ method: 'settings.save', params: { settings: { ...settings, extra: 1 } } }), ValidationError);
    const build = { floors: { chaosResMin: 50, maxResMin: { Fire: 88 } }, blend: 0.5, minGainPct: 1, lastSlot: 'Boots', lastBudget: '1d', lastMinBudget: null, lastTarget: 'full', weightEdits: { Boots: { 'explicit.stat_1': 0 } } };
    assert.deepEqual(parseInvokeRequest({ method: 'build.settings.save', params: { buildId: 'a.xml', settings: build } }).params, { buildId: 'a.xml', settings: build });
    for (const bad of [{ blend: 2 }, { lastSlot: 'Ring' }, { floors: { maxResMin: { Chaos: 10 } } }, { floors: { chaosResMin: Number.NaN } }]) {
        assert.throws(() => parseInvokeRequest({ method: 'build.settings.save', params: { buildId: 'a.xml', settings: { ...build, ...bad } } }), ValidationError, JSON.stringify(bad));
    }
});

test('rate and sign-in: manual rates are bounded; states are checked', () => {
    assert.deepEqual(parseInvokeRequest({ method: 'rate.setManual', params: { chaosPerDivine: 211.7 } }).params, { chaosPerDivine: 211.7 });
    for (const bad of [0, -5, Number.POSITIVE_INFINITY, '200', 1e9]) {
        assert.throws(() => parseInvokeRequest({ method: 'rate.setManual', params: { chaosPerDivine: bad } }), ValidationError, String(bad));
    }
    const state = { league: 'Covens', rate: { chaosPerDivine: 211.7, source: 'ggg', hourMs: 1, atMs: 2 }, busy: false, error: null, refreshBlockedUntilMs: null };
    assert.deepEqual(METHOD_RESULTS['rate.get'](state, 'r'), state);
    assert.throws(() => METHOD_RESULTS['rate.get']({ ...state, rate: { ...state.rate, source: 'ninja' } }, 'r'), ValidationError);
    assert.deepEqual(parseMainEvent({ kind: 'signin-state', state: { status: 'signed-in', message: null, checkedAtMs: 5 } }), { kind: 'signin-state', state: { status: 'signed-in', message: null, checkedAtMs: 5 } });
    assert.throws(() => parseMainEvent({ kind: 'signin-state', state: { status: 'maybe', message: null, checkedAtMs: null } }), ValidationError);
});

test('run request: the min price is optional, checked when given', () => {
    const base = { buildId: 'a.xml', slot: 'Helmet', budget: '200d', target: 'saved', depth: 'quick', listing: 'securable' };
    assert.equal(readRunRequest(base, 'r').minBudget, '');
    assert.equal(readRunRequest({ ...base, minBudget: ' 100d ' }, 'r').minBudget, '100d');
    assert.throws(() => readRunRequest({ ...base, minBudget: 'lots' }, 'r'), /minBudget/);
});
