import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UiLogLine } from '@poe-upgrade-finder/ipc';
import { findFocusLine } from '../src/log-focus.ts';

const line = (t: number, level: UiLogLine['level'], msg: string): UiLogLine => ({
    t: t,
    level: level,
    area: 'run',
    runId: 'Boots-1',
    msg: msg,
    data: null,
});

test("finds the feed entry's log line by level, text and the nearest time", () => {
    const lines: UiLogLine[] = [
        line(9000, 'warn', "PoB couldn't score a listing: x"),
        line(1004, 'warn', "PoB couldn't score a listing: x"),
        line(1001, 'error', "PoB couldn't score a listing: x"),
    ];
    assert.equal(findFocusLine(lines, { runId: 'Boots-1', level: 'warn', atMs: 1000, text: "PoB couldn't score a listing: x" }), 1);
});

test('nothing within a few seconds is no match', () => {
    assert.equal(findFocusLine([line(60000, 'warn', 'a')], { runId: 'r', level: 'warn', atMs: 0, text: 'a' }), -1);
    assert.equal(findFocusLine([line(0, 'warn', 'b')], { runId: 'r', level: 'warn', atMs: 0, text: 'a' }), -1);
});
