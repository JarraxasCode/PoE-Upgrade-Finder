import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { NO_PLAN_MATCH } from '@poe-upgrade-finder/core';
import type { EvaluatedItem } from '@poe-upgrade-finder/core';
import { CancelledError } from '@poe-upgrade-finder/trade';
import type { PolicySnapshot, TradePolicy } from '@poe-upgrade-finder/trade';
import { PauseGate } from '../src/run/pause-gate.ts';
import { pruneRuns, runIdOf } from '../src/run/shared.ts';
import { limitPanel, toUiItem } from '../src/run/ui-mapping.ts';

const root: string = mkdtempSync(join(tmpdir(), 'uf-run-'));
after(() => {
    rmSync(root, { recursive: true, force: true });
});

test('pause gate: open by default, holds while paused, releases on resume, cancel rejects', async () => {
    const gate: PauseGate = new PauseGate();
    await gate.wait();
    gate.pause();
    let passed: boolean = false;
    const waiting: Promise<void> = gate.wait().then(() => {
        passed = true;
    });
    await new Promise<void>((r) => setTimeout(r, 10));
    assert.equal(passed, false);
    gate.resume();
    await waiting;
    assert.equal(passed, true);

    gate.pause();
    const abort: AbortController = new AbortController();
    const cancelled: Promise<void> = gate.wait(abort.signal);
    abort.abort();
    await assert.rejects(cancelled, CancelledError);
    await assert.rejects(gate.wait(abort.signal), CancelledError);
});

function evaluated(over: Partial<{ gain: number; seller: string | undefined; text: string }> = {}): EvaluatedItem {
    return {
        item: {
            id: 'abc',
            text: over.text ?? 'Rarity: Rare\nGale Stride\nTwo-Toned Boots',
            name: 'Gale Stride',
            baseType: 'Two-Toned Boots',
            itemLevel: 84,
            statIds: ['explicit.stat_1'],
            seller: 'seller' in over ? over.seller : 'SomeSeller',
            price: { amount: 5, currency: 'chaos', type: '~b/o' },
            chaosEquivalent: 5,
            bandId: 'b1',
        },
        scored: { stats: { damage: 1, values: {} }, unparsed: ['weird line'] },
        gain: { gain: over.gain ?? 2.5, dpsPct: 3, ehpPct: 2 },
        checks: [],
        notes: [],
        floorsPass: true,
        failedFloors: [],
        missedTargets: [],
        flags: [{ checkId: 'life', kind: 'flag', status: 'fail', detail: 'Life: 4000 (was 4100)' }],
        plan: NO_PLAN_MATCH,
    };
}

test('UI items: no seller name crosses; NaN gains become null; hidden reasons pass through', () => {
    const base = { damage: 1, values: {} };
    const ui = toUiItem(evaluated(), 'Covens', base);
    assert.equal(ui.hasBuyLink, true);
    assert.equal(JSON.stringify(ui).includes('SomeSeller'), false);
    assert.deepEqual(ui.flags, ['Life: 4000 (was 4100)']);
    assert.deepEqual(ui.unparsed, ['weird line']);
    assert.equal(ui.hidden, null);
    assert.equal(toUiItem(evaluated({ gain: Number.NaN }), 'Covens', base).gainPct, null);
    assert.equal(toUiItem(evaluated({ seller: undefined }), 'Covens', base).hasBuyLink, false);
    const hidden = toUiItem(evaluated(), 'Covens', base, { evaluated: evaluated(), hidden: 'dominated', hiddenBy: 'xyz' });
    assert.equal(hidden.hidden, 'dominated');
    assert.equal(hidden.hiddenBy, 'xyz');
});

test('the rate-limit panel: windows per policy; a wait shows only until it ends', () => {
    const snap: Map<TradePolicy, PolicySnapshot> = new Map<TradePolicy, PolicySnapshot>([
        [
            'search',
            {
                policy: 'trade-search-request-limit',
                windows: [{ rule: 'Ip', count: 3, local: 3, server: 2, allowed: 5, limit: 8, period: 10, restrict: 60 }],
            },
        ],
        ['fetch', { policy: 'trade-fetch-request-limit', windows: [] }],
    ]);
    const panel = limitPanel(snap, { policy: 'search', untilMs: 2_000, reason: 'Ip window' }, 1_000);
    assert.deepEqual(
        panel.policies.map((p) => p.policy),
        ['fetch', 'search'],
    );
    assert.deepEqual(panel.policies[1]?.windows, [{ count: 3, allowed: 5, limit: 8, periodS: 10 }]);
    assert.equal(panel.wait?.reason, 'Ip window');
    assert.equal(limitPanel(snap, { policy: 'search', untilMs: 2_000, reason: 'x' }, 3_000).wait, null);
});

test('run files: ids recognised; only the newest 20 runs are kept, with all their files', () => {
    assert.equal(runIdOf('Ring1-2026-11-21T14-53-25-708Z.json'), 'Ring1-2026-11-21T14-53-25-708Z');
    assert.equal(runIdOf('Ring1-2026-11-21T14-53-25-708Z-raw.json'), 'Ring1-2026-11-21T14-53-25-708Z');
    assert.equal(runIdOf('BodyArmour-2026-11-21T14-53-25-708Z.txt'), 'BodyArmour-2026-11-21T14-53-25-708Z');
    assert.equal(runIdOf('notes.json'), undefined);
    assert.equal(runIdOf('settings.json'), undefined);

    const dir: string = join(root, 'runs');
    mkdirSync(dir, { recursive: true });
    for (let i: number = 0; i < 23; i++) {
        const id: string = `Boots-2026-11-${String(i + 1).padStart(2, '0')}T10-00-00-000Z`;
        for (const suffix of ['.json', '.txt', '-raw.json']) {
            const f: string = join(dir, `${id}${suffix}`);
            writeFileSync(f, '{}');
            utimesSync(f, 1_000 + i, 1_000 + i);
        }
    }
    writeFileSync(join(dir, 'keep-me.json'), '{}');
    const removed: string[] = pruneRuns(dir, 20);
    assert.deepEqual(removed.sort(), [
        'Boots-2026-11-01T10-00-00-000Z',
        'Boots-2026-11-02T10-00-00-000Z',
        'Boots-2026-11-03T10-00-00-000Z',
    ]);
    const left: string[] = readdirSync(dir);
    assert.equal(left.length, 20 * 3 + 1);
    assert.ok(left.includes('keep-me.json'));
});
