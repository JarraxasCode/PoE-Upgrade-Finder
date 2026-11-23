import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { filterLog, parseLogLine, readTail, redactForExport } from '../src/read.ts';

const lines: string[] = [
    JSON.stringify({ t: 1, level: 'debug', area: 'trade', msg: 'd' }),
    JSON.stringify({ t: 2, level: 'info', area: 'run', runId: 'Boots-1', msg: 'search', data: { total: 10 } }),
    'not json',
    JSON.stringify({ t: 3, level: 'warn', area: 'trade', msg: 'wait' }),
    JSON.stringify({ t: 4, level: 'error', area: 'engine', msg: 'boom' }),
    JSON.stringify({ t: 5, level: 'nope', area: 'x', msg: 'bad level' }),
];

test('parse: only lines the logger writes', () => {
    assert.equal(parseLogLine('not json'), undefined);
    assert.equal(parseLogLine(lines[5] ?? ''), undefined);
    assert.deepEqual(parseLogLine(lines[1] ?? ''), {
        t: 2,
        level: 'info',
        area: 'run',
        msg: 'search',
        runId: 'Boots-1',
        data: { total: 10 },
    });
});

test('filter: minimum level, area, run; newest first; areas for the picker', () => {
    const text: string = lines.join('\n');
    const warn = filterLog(text, { minLevel: 'warn', limit: 100 });
    assert.deepEqual(
        warn.lines.map((l) => l.t),
        [4, 3],
    );
    assert.deepEqual(warn.areas, ['engine', 'run', 'trade']);
    assert.deepEqual(
        filterLog(text, { minLevel: 'debug', area: 'trade', limit: 100 }).lines.map((l) => l.t),
        [3, 1],
    );
    assert.deepEqual(
        filterLog(text, { minLevel: 'debug', runId: 'Boots-1', limit: 100 }).lines.map((l) => l.t),
        [2],
    );
    assert.deepEqual(
        filterLog(text, { minLevel: 'debug', limit: 2 }).lines.map((l) => l.t),
        [4, 3],
    );
});

test('tail: starts at a whole line when the file is cut', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-log-'));
    try {
        const file: string = join(dir, 'app.jsonl');
        writeFileSync(file, `${lines.join('\n')}\n`);
        // The last line is under 60 bytes: a 60-byte tail cuts into the line before it, which is dropped.
        assert.equal(readTail(file, 60), `${lines[5] ?? ''}\n`);
        assert.equal(readTail(join(dir, 'missing.jsonl')), '');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('export: redacted again, seller keys dropped, junk lines left out', () => {
    const text: string = [
        JSON.stringify({
            t: 1,
            level: 'info',
            area: 'trade',
            msg: 'x',
            data: { seller: 'Someone', cookie: 'POESESSID=abc', nested: { accountName: 'A', ok: 1 } },
        }),
        'garbage',
    ].join('\n');
    const out: string = redactForExport(text);
    assert.equal(out.split('\n').filter((l) => l !== '').length, 1);
    assert.ok(!out.includes('Someone') && !out.includes('abc') && !out.includes('"A"'));
    assert.ok(out.includes('"ok":1'));
});
