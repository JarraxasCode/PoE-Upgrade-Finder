import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EngineClient, EngineError } from '../src/index.ts';
import type { EngineClientOptions, ScoreItemResult, ScoreSummary } from '../src/index.ts';

const fake: string = fileURLToPath(new URL('./fake-engine.ts', import.meta.url));

function client(mode: string = 'normal', options: Partial<EngineClientOptions> = {}): EngineClient {
    return new EngineClient({ command: { command: process.execPath, args: [fake, mode], env: {} }, startupTimeoutMs: 5000, ...options });
}

async function scoreAll(engine: EngineClient, items: readonly string[], batchSize: number, signal?: AbortSignal): Promise<{ results: ScoreItemResult[]; summary: ScoreSummary }> {
    const results: ScoreItemResult[] = [];
    const summary: ScoreSummary = await engine.score('Boots', items, (r: ScoreItemResult) => {
        results.push(r);
    }, signal ? { batchSize: batchSize, signal: signal } : { batchSize: batchSize });
    return { results: results, summary: summary };
}

test('loads a build, decodes stats and keeps warnings', async () => {
    const engine: EngineClient = client();
    try {
        const ready = await engine.start();
        assert.equal(ready.pobVersion, 'fake');
        const build = await engine.loadBuild('<xml/>', 'Test');
        assert.match(build.buildId, /^b\d+-1$/);
        assert.deepEqual(build.skills, []);
        assert.deepEqual(build.warnings, [{ code: 'no-damage-target', message: 'reads 0' }]);
        assert.equal(build.baseline.values['TotalEHP'], Number.POSITIVE_INFINITY);
        assert.equal(build.baseline.values['CorruptedBloodImmunity'], true);
        const stats = await engine.stats();
        assert.equal(stats.stats.damage, 100);
        assert.equal(stats.target.kind, 'fullDps');
    } finally {
        await engine.shutdown();
    }
});

test('engine errors keep their code and leave the worker running', async () => {
    const engine: EngineClient = client();
    try {
        await assert.rejects(engine.stats(), (e: unknown) => e instanceof EngineError && e.code === 'no-build');
        await assert.rejects(engine.loadBuild('BROKEN'), (e: unknown) => e instanceof EngineError && e.code === 'load-failed' && !e.workerLost);
        assert.equal(engine.loaded, undefined);
        await engine.loadBuild('<xml/>');
        await engine.stats();
        assert.equal(engine.starts, 1);
    } finally {
        await engine.shutdown();
    }
});

test('score streams every item in order across batches', async () => {
    const engine: EngineClient = client();
    try {
        await engine.loadBuild('<xml/>');
        const { results, summary } = await scoreAll(engine, ['a', 'b', 'BAD', 'd', 'e'], 2);
        assert.deepEqual(results.map((r: ScoreItemResult) => r.index), [0, 1, 2, 3, 4]);
        assert.deepEqual(results.map((r: ScoreItemResult) => r.ok), [true, true, false, true, true]);
        const fourth: ScoreItemResult | undefined = results[3];
        assert.ok(fourth?.ok);
        assert.equal(fourth.item.name, 'd');
        assert.equal(fourth.stats.damage, 101);
        assert.deepEqual({ ...summary, seconds: 0 }, { count: 5, scored: 4, failed: 1, skipped: 0, cancelled: false, restarts: 0, seconds: 0 });
    } finally {
        await engine.shutdown();
    }
});

test('a crash fails the item in flight, restarts with the build and carries on', async () => {
    const engine: EngineClient = client();
    try {
        const first = await engine.loadBuild('<xml/>');
        const { results, summary } = await scoreAll(engine, ['a', 'CRASH', 'c', 'd'], 4);
        assert.deepEqual(results.map((r: ScoreItemResult) => [r.index, r.ok]), [[0, true], [1, false], [2, true], [3, true]]);
        const lost: ScoreItemResult | undefined = results[1];
        assert.ok(lost && !lost.ok);
        assert.equal(lost.error.code, 'worker-exited');
        assert.equal(summary.restarts, 1);
        assert.equal(engine.starts, 2);
        assert.notEqual(engine.loaded?.buildId, first.buildId);
        await engine.stats();
    } finally {
        await engine.shutdown();
    }
});

test('a crash after the last item of a batch fails no item, and the next batch is scored', async () => {
    const engine: EngineClient = client();
    try {
        await engine.loadBuild('<xml/>');
        const { results, summary } = await scoreAll(engine, ['a', 'SCORE-THEN-CRASH', 'c'], 2);
        assert.deepEqual(results.map((r: ScoreItemResult) => [r.index, r.ok]), [[0, true], [1, true], [2, true]]);
        assert.equal(summary.failed, 0);
        assert.equal(summary.skipped, 0);
        assert.equal(summary.restarts, 1);
    } finally {
        await engine.shutdown();
    }
});

test('a hang times out, fails that item and carries on', async () => {
    const engine: EngineClient = client('normal', { idleTimeoutMs: { score: 300 } });
    try {
        await engine.loadBuild('<xml/>');
        const { results, summary } = await scoreAll(engine, ['a', 'HANG', 'c'], 10);
        assert.deepEqual(results.map((r: ScoreItemResult) => [r.index, r.ok]), [[0, true], [1, false], [2, true]]);
        const lost: ScoreItemResult | undefined = results[1];
        assert.ok(lost && !lost.ok);
        assert.equal(lost.error.code, 'timeout');
        assert.equal(summary.restarts, 1);
    } finally {
        await engine.shutdown();
    }
});

test('too many restarts stop the run', async () => {
    const engine: EngineClient = client('normal', { maxRestartsPerScore: 1 });
    try {
        await engine.loadBuild('<xml/>');
        await assert.rejects(scoreAll(engine, ['CRASH', 'CRASH', 'c'], 10), (e: unknown) => e instanceof EngineError && e.code === 'worker-exited');
    } finally {
        await engine.shutdown();
    }
});

test('cancel takes effect between batches', async () => {
    const engine: EngineClient = client();
    try {
        await engine.loadBuild('<xml/>');
        const controller: AbortController = new AbortController();
        const results: ScoreItemResult[] = [];
        const summary: ScoreSummary = await engine.score('Boots', ['a', 'b', 'c', 'd', 'e'], (r: ScoreItemResult) => {
            results.push(r);
            controller.abort();
        }, { batchSize: 2, signal: controller.signal });
        assert.equal(results.length, 2);
        assert.equal(summary.cancelled, true);
        assert.equal(summary.skipped, 3);
    } finally {
        await engine.shutdown();
    }
});

test('startup failures are reported', async () => {
    await assert.rejects(client('fatal').start(), (e: unknown) => e instanceof EngineError && e.code === 'startup-failed' && /no PoB here/.test(e.message));
    const silent: EngineClient = client('silent', { startupTimeoutMs: 300 });
    await assert.rejects(silent.start(), (e: unknown) => e instanceof EngineError && e.code === 'startup-failed' && /Loading passive|no ready event/.test(e.message));
    await assert.rejects(client('bad-json').start(), (e: unknown) => e instanceof EngineError && e.code === 'protocol');
    const missing: EngineClient = new EngineClient({ command: { command: 'C:/no/such/engine.exe', args: [], env: {} } });
    await assert.rejects(missing.start(), (e: unknown) => e instanceof EngineError && e.code === 'startup-failed');
});

test('a shut-down client refuses commands', async () => {
    const engine: EngineClient = client();
    await engine.start();
    await engine.shutdown();
    await assert.rejects(engine.ping(), (e: unknown) => e instanceof EngineError && e.code === 'shut-down');
});
