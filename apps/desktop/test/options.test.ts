import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '@poe-upgrade-finder/cli/args';
import { parseBudget, parseHeadless } from '../src/options.ts';
import type { HeadlessOptions } from '../src/options.ts';

test('budgets in chaos or divines', () => {
    assert.deepEqual(parseBudget('300'), { amount: 300, unit: 'chaos' });
    assert.deepEqual(parseBudget('300c'), { amount: 300, unit: 'chaos' });
    assert.deepEqual(parseBudget('1.5d'), { amount: 1.5, unit: 'divine' });
    assert.deepEqual(parseBudget('2 div'), { amount: 2, unit: 'divine' });
    assert.throws(() => parseBudget('0'), UsageError);
    assert.throws(() => parseBudget('lots'), UsageError);
    assert.throws(() => parseBudget(undefined), UsageError);
});

test('headless options: defaults and parsing', () => {
    const o: HeadlessOptions = parseHeadless(['--build', 'b.xml', '--slot', 'boots', '--budget', '300c']);
    assert.equal(o.slot, 'Boots');
    assert.equal(o.league, 'Covens');
    assert.equal(o.depth, 'thorough');
    assert.equal(o.perBand, 100);
    assert.equal(o.listing, 'securable');
    assert.equal(o.blend, 0.5);
    assert.deepEqual(o.target, { kind: 'saved' });
    assert.equal(o.rate, undefined);
    assert.equal(o.record, true);
    assert.equal(o.dryRun, false);

    const q: HeadlessOptions = parseHeadless([
        '--build',
        'b.xml',
        '--slot',
        'Ring 1',
        '--budget',
        '1d',
        '--depth',
        'quick',
        '--listing',
        'whisper',
        '--rate',
        '207.9',
        '--target',
        'skill:2.1',
        '--no-record',
        '--dry-run',
        '--league',
        'Hardcore Covens',
    ]);
    assert.equal(q.perBand, 20);
    assert.equal(q.listing, 'online');
    assert.equal(q.rate, 207.9);
    assert.deepEqual(q.target, { kind: 'skill', group: 2, activeSkill: 1 });
    assert.equal(q.record, false);
    assert.equal(q.dryRun, true);
    assert.equal(q.league, 'Hardcore Covens');
    assert.throws(() => parseHeadless(['--slot', 'Boots', '--budget', '3']), /--build/);
    assert.throws(() => parseHeadless(['--build', 'b', '--slot', 'Boots', '--budget', '3', '--depth', 'deep']), UsageError);
});
