import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBudgetText } from '@poe-upgrade-finder/ipc';
import type { FloorSettings } from '@poe-upgrade-finder/ipc';
import { parseNumberText, setBool, setMaxResMin, setNumber, setTargetMaxRes, setTargetNumber } from '../src/floors-form.ts';
import { ago, buildLabel, compact, signedPct } from '../src/format.ts';

test('compact numbers', () => {
    assert.equal(compact(1_840_000), '1.84M');
    assert.equal(compact(96_412), '96.4k');
    assert.equal(compact(7_412), '7,412');
    assert.equal(compact(2_000_000), '2M');
    assert.equal(signedPct(1.654), '+1.65%');
    assert.equal(signedPct(-0.4), '-0.40%');
});

test('ago', () => {
    const now: number = 10 * 86_400_000;
    assert.equal(ago(now - 5_000, now), 'just now');
    assert.equal(ago(now - 5 * 60_000, now), '5 min ago');
    assert.equal(ago(now - 3 * 3_600_000, now), '3 h ago');
    assert.equal(ago(now - 30 * 3_600_000, now), 'yesterday');
    assert.equal(ago(now - 4 * 86_400_000, now), '4 days ago');
});

test('build labels', () => {
    assert.equal(
        buildLabel({ id: 'a.xml', name: 'RF', folder: '', className: 'Marauder', ascendClassName: 'Chieftain', level: 94, modifiedMs: 0 }),
        'RF · Chieftain 94',
    );
    assert.equal(
        buildLabel({ id: 'a.xml', name: 'Blank', folder: '', className: null, ascendClassName: null, level: null, modifiedMs: 0 }),
        'Blank',
    );
});

test('budgets', () => {
    assert.deepEqual(parseBudgetText('300'), { amount: 300, unit: 'chaos' });
    assert.deepEqual(parseBudgetText(' 300c '), { amount: 300, unit: 'chaos' });
    assert.deepEqual(parseBudgetText('1.5d'), { amount: 1.5, unit: 'divine' });
    assert.deepEqual(parseBudgetText('2 div'), { amount: 2, unit: 'divine' });
    assert.equal(parseBudgetText('0'), undefined);
    assert.equal(parseBudgetText('lots'), undefined);
    assert.equal(parseBudgetText('-5'), undefined);
});

test('floor edits: on, off, per element, targets; empty groups disappear', () => {
    let f: FloorSettings = { chaosResMin: 50, maxResMin: { Fire: 88 }, elementalResCapped: true };
    f = setNumber(f, 'chaosResMin', undefined);
    assert.equal('chaosResMin' in f, false);
    f = setMaxResMin(f, 'Cold', 80);
    assert.deepEqual(f.maxResMin, { Fire: 88, Cold: 80 });
    f = setMaxResMin(setMaxResMin(f, 'Fire', undefined), 'Cold', undefined);
    assert.equal('maxResMin' in f, false);
    f = setBool(f, 'elementalResCapped', false);
    assert.equal('elementalResCapped' in f, false);
    f = setTargetMaxRes(setTargetNumber(f, 'overcapMin', 10), 'Fire', 90);
    assert.deepEqual(f.targets, { overcapMin: 10, maxRes: { Fire: 90 } });
    f = setTargetMaxRes(setTargetNumber(f, 'overcapMin', undefined), 'Fire', undefined);
    assert.deepEqual(f, {});
    assert.equal(parseNumberText(' 75 '), 75);
    assert.equal(parseNumberText(''), undefined);
    assert.equal(parseNumberText('x'), undefined);
});
