import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@poe-upgrade-finder/logging';
import { isRecord } from '@poe-upgrade-finder/validate';
import { recordedListings } from '../src/run/replay-trade.ts';
import { fetchTarget, TradeRecorder } from '../src/services/trade-recorder.ts';

const V19: string = fileURLToPath(new URL('../../../test/fixtures/trade/v19-boots-raw.json', import.meta.url));
const dir: string = mkdtempSync(join(tmpdir(), 'uf-recorder-'));
after(() => {
    rmSync(dir, { recursive: true, force: true });
});

const warnings: string[] = [];
const log: Logger = {
    log(_level: string, message: string): void {
        warnings.push(message);
    },
};

test('fetch paths: the listing ids and the search id', () => {
    assert.deepEqual(fetchTarget('/api/trade/fetch/a1,b2?query=Xyz9'), { ids: ['a1', 'b2'], queryId: 'Xyz9' });
    assert.deepEqual(fetchTarget('/api/trade/fetch/a%2Bb'), { ids: ['a+b'], queryId: null });
    assert.equal(fetchTarget('/api/trade/search/Standard'), undefined);
});

test('a recording is what --replay reads: the same listings back, tokens stripped, other calls left out', () => {
    // Real fetch responses (the V19 recording), as the trade client hands them to onResponse.
    const raw: unknown = JSON.parse(readFileSync(V19, 'utf8'));
    assert.ok(isRecord(raw) && Array.isArray(raw['fetch']));
    const calls: readonly unknown[] = (raw['fetch'] as readonly unknown[]).slice(0, 3);
    const file: string = join(dir, 'recorded.json');
    const recorder: TradeRecorder = new TradeRecorder(file, log);
    recorder.record({ policy: 'search', method: 'POST', path: '/api/trade/search/Standard', status: 200, json: { id: 'Q1', total: 3 } });
    recorder.record({ policy: 'data', method: 'GET', path: '/api/trade/data/stats', status: 200, json: { result: [] } });
    for (const call of calls) {
        assert.ok(isRecord(call) && Array.isArray(call['ids']) && isRecord(call['json']));
        const ids: string = (call['ids'] as readonly string[]).join(',');
        // A token the site sends per listing, which must not be saved.
        const json: unknown = {
            ...call['json'],
            result: (call['json']['result'] as readonly unknown[]).map((r: unknown) =>
                isRecord(r) && isRecord(r['listing']) ? { ...r, listing: { ...r['listing'], whisper_token: 'secret' } } : r,
            ),
        };
        recorder.record({ policy: 'fetch', method: 'GET', path: `/api/trade/fetch/${ids}?query=Q1`, status: 200, json: json });
    }
    const text: string = readFileSync(file, 'utf8');
    assert.equal(text.includes('secret'), false, 'whisper tokens are stripped');
    const saved: unknown = JSON.parse(text);
    assert.ok(isRecord(saved) && Array.isArray(saved['search']) && Array.isArray(saved['fetch']));
    assert.equal(saved['search'].length, 1);
    assert.equal(saved['fetch'].length, calls.length);
    // --replay's reader finds every listing of those fetches.
    const expected: number = new Set(calls.flatMap((c: unknown) => (isRecord(c) ? (c['ids'] as readonly string[]) : []))).size;
    assert.equal(recordedListings(file).length, expected);
    assert.deepEqual(warnings, []);
});
