import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { dayStamp, JsonlLogger, redact } from '../src/logger.ts';
import type { LogLine } from '../src/logger.ts';

const dirs: string[] = [];

function tempDir(): string {
    const dir: string = mkdtempSync(join(tmpdir(), 'poe-uf-logs-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const d of dirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
    }
});

function lines(path: string): LogLine[] {
    return readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((l: string) => JSON.parse(l) as LogLine);
}

const T: number = new Date(2026, 10, 22, 14, 30).getTime();

test('writes one JSON object per line to the day file, and to the run file during a run', () => {
    const dir: string = tempDir();
    const logger: JsonlLogger = new JsonlLogger({ dir: dir, now: () => T });
    logger.area('app').log('info', 'started');
    logger.startRun('run 2026-11-22T14:30');
    logger.area('trade').log('warn', 'POST /api/trade/search/Covens -> 429', { reqId: 7, status: 429 });
    logger.endRun();
    const day: LogLine[] = lines(join(dir, `app-${dayStamp(T)}.jsonl`));
    assert.equal(day.length, 2);
    assert.deepEqual(day[0], { t: T, level: 'info', area: 'app', msg: 'started' });
    assert.deepEqual(day[1], {
        t: T,
        level: 'warn',
        area: 'trade',
        runId: 'run_2026-11-22T14_30',
        reqId: 7,
        msg: 'POST /api/trade/search/Covens -> 429',
        data: { reqId: 7, status: 429 },
    });
    const run: LogLine[] = lines(join(dir, 'runs', 'run_2026-11-22T14_30.jsonl'));
    assert.equal(run.length, 1);
    assert.equal(run[0]?.area, 'trade');
});

test('debug lines only with the toggle on', () => {
    const dir: string = tempDir();
    const logger: JsonlLogger = new JsonlLogger({ dir: dir, now: () => T });
    logger.area('engine').log('debug', 'hidden');
    logger.debug = true;
    logger.area('engine').log('debug', 'shown');
    assert.deepEqual(
        lines(join(dir, `app-${dayStamp(T)}.jsonl`)).map((l: LogLine) => l.msg),
        ['shown'],
    );
});

test('redacts secret keys and cookie strings at any depth; non-finite numbers become strings', () => {
    assert.deepEqual(
        redact({
            headers: { 'set-cookie': 'POESESSID=abc', Cookie: 'x', 'x-rate-limit-rules': 'Account,Ip' },
            nested: [{ password: 'p', whisper_token: 't', ok: 1 }],
            note: 'sent POESESSID=0123abcd; cf_clearance=zzz to the site',
            ehp: Number.POSITIVE_INFINITY,
        }),
        {
            headers: { 'set-cookie': '[redacted]', Cookie: '[redacted]', 'x-rate-limit-rules': 'Account,Ip' },
            nested: [{ password: '[redacted]', whisper_token: '[redacted]', ok: 1 }],
            note: 'sent POESESSID=[redacted]; cf_clearance=[redacted] to the site',
            ehp: 'Infinity',
        },
    );
});

test('prunes files older than the retention, then the oldest past the size cap', () => {
    const dir: string = tempDir();
    new JsonlLogger({ dir: dir, now: () => T }); // creates logs/ and logs/runs/
    const old: string = join(dir, 'app-2026-11-01.jsonl');
    const mid: string = join(dir, 'runs', 'r1.jsonl');
    const recent: string = join(dir, 'app-2026-11-21.jsonl');
    const other: string = join(dir, 'notes.txt');
    for (const [path, ageDays] of [
        [old, 21],
        [mid, 3],
        [recent, 1],
        [other, 30],
    ] as const) {
        writeFileSync(path, 'x'.repeat(1000));
        const when: Date = new Date(T - ageDays * 24 * 3600 * 1000);
        utimesSync(path, when, when);
    }
    new JsonlLogger({ dir: dir, now: () => T, maxBytes: 1500 });
    assert.equal(existsSync(old), false, 'older than 14 days');
    assert.equal(existsSync(mid), false, 'oldest past the 1500-byte cap');
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(other), true, 'only .jsonl files are touched');
    assert.deepEqual(readdirSync(join(dir, 'runs')), []);
});

test('a failed write never throws into the caller', () => {
    const dir: string = tempDir();
    const echoed: LogLine[] = [];
    const logger: JsonlLogger = new JsonlLogger({
        dir: dir,
        now: () => T,
        echo: (line: LogLine) => {
            echoed.push(line);
        },
    });
    rmSync(dir, { recursive: true, force: true }); // the folder is gone, so every append fails
    assert.doesNotThrow(() => {
        logger.area('trade').log('info', 'GET /api/trade/fetch -> 200');
    });
    assert.equal(echoed.length, 1);
});

test('data that JSON cannot hold never throws into the caller: a BigInt is written as text, a throwing getter as a note', () => {
    const dir: string = tempDir();
    const logger: JsonlLogger = new JsonlLogger({ dir: dir, now: () => T });
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'bad', {
        enumerable: true,
        get: (): never => {
            throw new Error('no');
        },
    });
    assert.doesNotThrow(() => {
        logger.area('engine').log('info', 'big', { n: 12345678901234567890n });
        logger.area('engine').log('info', 'getter', { reqId: 3, x: throwing });
    });
    const day: LogLine[] = lines(join(dir, `app-${dayStamp(T)}.jsonl`));
    assert.deepEqual(day[0]?.data, { n: '12345678901234567890' });
    assert.equal(day[1]?.msg, 'getter');
    assert.deepEqual(day[1]?.data, { logError: 'the data could not be written as JSON' });
});

test('prunes again while the app stays open, not only at start-up', () => {
    const dir: string = tempDir();
    let now: number = T;
    const logger: JsonlLogger = new JsonlLogger({ dir: dir, now: () => now });
    const old: string = join(dir, 'app-2026-11-08.jsonl');
    writeFileSync(old, 'x');
    const when: Date = new Date(T - 13 * 24 * 3600 * 1000); // 13 days old: kept at start-up
    utimesSync(old, when, when);
    logger.area('app').log('info', 'a line');
    assert.equal(existsSync(old), true);
    now = T + 2 * 24 * 3600 * 1000; // two days later, the app still open
    logger.area('app').log('info', 'another line');
    assert.equal(existsSync(old), false, 'pruned once 14 days old');
});

test('pruning a folder that has gone never throws', () => {
    const dir: string = tempDir();
    const logger: JsonlLogger = new JsonlLogger({ dir: dir, now: () => T });
    rmSync(dir, { recursive: true, force: true });
    assert.doesNotThrow(() => logger.prune());
});
