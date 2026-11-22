import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinnedPobDir, readQueryModsReport } from '@poe-upgrade-finder/engine-client';

test('pinnedPobDir: engine/pob/<pinned version> when it holds a PoB copy, else undefined', () => {
    const root: string = mkdtempSync(join(tmpdir(), 'pin-'));
    try {
        mkdirSync(join(root, 'engine'), { recursive: true });
        assert.equal(pinnedPobDir(root), undefined, 'no pin');
        writeFileSync(join(root, 'engine', 'pob-pin.json'), JSON.stringify({ version: '2.68.1', tag: 'v2.68.1', commit: 'a'.repeat(40) }));
        assert.equal(pinnedPobDir(root), undefined, 'no copy');
        mkdirSync(join(root, 'engine', 'pob', '2.68.1', 'src'), { recursive: true });
        writeFileSync(join(root, 'engine', 'pob', '2.68.1', 'src', 'HeadlessWrapper.lua'), '');
        assert.equal(pinnedPobDir(root), join(root, 'engine', 'pob', '2.68.1'));
        writeFileSync(join(root, 'engine', 'pob-pin.json'), JSON.stringify({ version: '../x' }));
        assert.equal(pinnedPobDir(root), undefined, 'bad version');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('readQueryModsReport: the last line is the result; a thin table is refused', () => {
    const ok: string = 'Rares loaded\n{"entries":{"Explicit":2094,"Corrupted":264},"ok":true,"seconds":19.1,"unmatched":252}\n';
    assert.deepEqual(readQueryModsReport(ok), { seconds: 19.1, entries: { Explicit: 2094, Corrupted: 264 }, unmatched: 252 });
    assert.throws(() => readQueryModsReport('{"entries":{"Explicit":12},"ok":true,"seconds":1,"unmatched":0}'), /refusing/);
    assert.throws(() => readQueryModsReport('lua error: boom'), /no JSON/);
});
