import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { dayStamp } from '@poe-upgrade-finder/logging';
import { exportZip, recentLogs } from '../src/services/logs.ts';

/** Names and contents of a zip's entries (local headers, in order). */
function entries(buffer: Buffer): Map<string, string> {
    const out: Map<string, string> = new Map<string, string>();
    let at: number = 0;
    while (buffer.readUInt32LE(at) === 0x04034b50) {
        const packed: number = buffer.readUInt32LE(at + 18);
        const nameLength: number = buffer.readUInt16LE(at + 26);
        const name: string = buffer.subarray(at + 30, at + 30 + nameLength).toString('utf8');
        const dataAt: number = at + 30 + nameLength + buffer.readUInt16LE(at + 28);
        out.set(name, inflateRawSync(buffer.subarray(dataAt, dataAt + packed)).toString('utf8'));
        at = dataAt + packed;
    }
    return out;
}

test('logs: recent lines from today; export zips today and the run, redacted', () => {
    const dir: string = mkdtempSync(join(tmpdir(), 'uf-logs-'));
    try {
        const now: number = Date.now();
        mkdirSync(join(dir, 'runs'));
        const line = (level: string, msg: string, data?: unknown): string =>
            JSON.stringify({ t: now, level: level, area: 'run', runId: 'Boots-1', msg: msg, data: data });
        writeFileSync(
            join(dir, `app-${dayStamp(now)}.jsonl`),
            [line('info', 'a'), line('error', 'b', { seller: 'Someone', total: 3 })].join('\n') + '\n',
        );
        writeFileSync(join(dir, 'runs', 'Boots-1.jsonl'), line('info', 'run line') + '\n');

        const view = recentLogs(dir, { minLevel: 'warn', area: null, runId: null, limit: 10 });
        assert.deepEqual(
            view.lines.map((l) => l.msg),
            ['b'],
        );
        assert.equal(view.lines[0]?.data, '{"seller":"Someone","total":3}', 'the view shows data as logged (redact() keeps non-secrets)');

        const files: Map<string, string> = entries(exportZip(dir, 'Boots-1', { appVersion: '0.1.0' }, now));
        assert.deepEqual([...files.keys()], [`app-${dayStamp(now)}.jsonl`, 'runs/Boots-1.jsonl', 'info.json']);
        assert.ok(!(files.get(`app-${dayStamp(now)}.jsonl`) ?? '').includes('Someone'), 'seller names are dropped from the export');
        assert.ok((files.get('runs/Boots-1.jsonl') ?? '').includes('run line'));
        assert.equal(JSON.parse(files.get('info.json') ?? '{}').appVersion, '0.1.0');

        // No run log, no run id: just today and info.
        assert.deepEqual([...entries(exportZip(dir, null, {}, now)).keys()], [`app-${dayStamp(now)}.jsonl`, 'info.json']);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
