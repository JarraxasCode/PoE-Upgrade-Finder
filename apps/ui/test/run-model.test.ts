import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunHeader, RunSnapshot, UiItem, UiSearch } from '@poe-upgrade-finder/ipc';
import { bandRows, blendText, goodFinds, hiddenCounts, liveFiltered, priceText, progress } from '../src/run-model.ts';

const header: RunHeader = {
    runId: 'r1', buildId: 'a.xml', buildName: 'RF', slot: 'Boots', league: 'Covens', budgetLabel: '300c', budgetChaos: 300, targetLabel: 'Full DPS',
    depth: 'quick', perBand: 20, listing: 'securable', minGainPct: 1, blend: 0.5, chaosPerDivine: 200, startedAtMs: 0, baselineDamage: 1e6, baselineEhp: 5e4,
    currentItem: 'Old Boots', currentView: null, weightedStats: 20, hardNeeds: [], searchedFor: [],
    bands: [
        { id: 'b0', label: 'up to 1c', role: 'main' },
        { id: 'b1', label: '1c to 33c', role: 'main' },
        { id: 'b2', label: '300c to 375c', role: 'over' },
    ],
};

function item(id: string, gain: number | null, over: Partial<UiItem> = {}): UiItem {
    return {
        id: id, name: id, baseType: 'Boots', itemLevel: 80, price: { amount: 5, currency: 'chaos' }, chaos: 5, bandId: 'b0', gainPct: gain, dpsPct: gain, ehpPct: gain,
        floorsPass: true, failedFloors: [], flags: [], missedTargets: [], notes: [], unparsed: [], text: '', view: null, changes: [], hasBuyLink: true, hidden: null, hiddenBy: null, ...over,
    };
}

function search(bandId: string, total: number, planned: number, error: string | null = null): UiSearch {
    return { bandId: bandId, option: 'chaos', total: total, fetchPlanned: planned, complexity: 150, error: error };
}

test('good finds: floors pass and at least the minimum gain, best first then cheaper', () => {
    const items: UiItem[] = [
        item('a', 2), item('b', 0.5), item('c', 5, { floorsPass: false }), item('d', 2, { chaos: 1, price: { amount: 1, currency: 'chaos' } }), item('e', null),
    ];
    assert.deepEqual(goodFinds(items, 1).map((i) => i.id), ['d', 'a']);
    assert.deepEqual(liveFiltered(items, 1), { floor: 1, sideGrade: 2, total: 3 });
});

test('bands: done, the one searching, waiting; refused when every search failed', () => {
    const snap: RunSnapshot = {
        header: header, phase: 'searching', searches: [search('b0', 40, 20), search('b1', 900, 20)], items: [item('a', 2), item('x', 1, { bandId: 'b1' })],
        bandsDone: ['b0'], feed: [], summary: null,
    };
    const rows = bandRows(snap);
    assert.deepEqual(rows.map((r) => r.status), ['done', 'searching', 'waiting']);
    assert.deepEqual(rows.map((r) => r.matches), [40, 900, null]);
    assert.equal(rows[1]?.scored, 1);
    const p = progress(snap);
    assert.deepEqual(p, { scored: 2, expected: 20 + 20 + 20, bandIndex: 2, bands: 3 });
    const refused = bandRows({ ...snap, searches: [search('b0', 0, 0, 'too complex')], bandsDone: [] });
    assert.equal(refused[0]?.status, 'refused');
    assert.equal(refused[1]?.status, 'searching');
});

test('prices and hidden counts', () => {
    assert.equal(priceText(item('a', 1)), '5c');
    assert.equal(priceText(item('a', 1, { price: { amount: 1.25, currency: 'divine' } })), '1.25 div');
    assert.equal(priceText(item('a', 1, { price: null })), 'no price');
    const counts = hiddenCounts([item('a', 1, { hidden: 'floor' }), item('b', 1, { hidden: 'floor' }), item('c', 1, { hidden: 'dominated' }), item('d', 1)]);
    assert.equal(counts.get('floor'), 2);
    assert.equal(counts.get('dominated'), 1);
    assert.equal(counts.get('low-gain'), undefined);
});

test('band matches flag the site cap of 10,000 per search; the blend reads as DPS + EHP', () => {
    const snap: RunSnapshot = {
        header: header, phase: 'done', searches: [search('b0', 10000, 50), search('b0', 9000, 50), search('b1', 671, 100)], items: [],
        bandsDone: ['b0', 'b1'], feed: [], summary: null,
    };
    const rows = bandRows(snap);
    assert.deepEqual(rows.map((r) => [r.matches, r.matchesCapped, r.planned]), [[19000, true, 100], [671, false, 100], [null, false, 0]]);
    assert.equal(blendText(0.5), 'DPS 50% + EHP 50%');
    assert.equal(blendText(0.7), 'DPS 70% + EHP 30%');
});
