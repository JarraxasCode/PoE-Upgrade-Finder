import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunHeader, RunSnapshot, UiItem, UiSearch } from '@poe-upgrade-finder/ipc';
import {
    chipValue,
    currentItemText,
    foldCopies,
    slotWasEmpty,
    bandRows,
    blendText,
    goodFinds,
    hiddenCounts,
    liveFiltered,
    planCheckText,
    planChip,
    priceText,
    progress,
    skippedText,
} from '../src/run-model.ts';
import type { FoldedItem } from '../src/run-model.ts';

const header: RunHeader = {
    runId: 'r1',
    buildId: 'a.xml',
    buildName: 'RF',
    slot: 'Boots',
    league: 'Covens',
    budgetLabel: '300c',
    budgetChaos: 300,
    targetLabel: 'Full DPS',
    depth: 'quick',
    perBand: 20,
    listing: 'securable',
    minGainPct: 1,
    blend: 0.5,
    chaosPerDivine: 200,
    startedAtMs: 0,
    baselineDamage: 1e6,
    baselineEhp: 5e4,
    currentItem: 'Old Boots',
    currentView: null,
    weightedStats: 20,
    hardNeeds: [],
    plan: null,
    unique: null,
    uniqueNotes: [],
    sockets: [],
    levelFilter: 'Up to level 92 (your level)',
    searchedFor: [],
    bands: [
        { id: 'b0', label: 'up to 1c', role: 'main' },
        { id: 'b1', label: '1c to 33c', role: 'main' },
        { id: 'b2', label: '300c to 375c', role: 'over' },
    ],
};

function item(id: string, gain: number | null, over: Partial<UiItem> = {}): UiItem {
    return {
        id: id,
        name: id,
        baseType: 'Boots',
        itemLevel: 80,
        price: { amount: 5, currency: 'chaos' },
        chaos: 5,
        bandId: 'b0',
        role: 'main',
        gainPct: gain,
        dpsPct: gain,
        ehpPct: gain,
        floorsPass: true,
        failedFloors: [],
        flags: [],
        missedTargets: [],
        notes: [],
        unparsed: [],
        text: '',
        view: null,
        changes: [],
        planChecks: [],
        hasBuyLink: true,
        hidden: null,
        hiddenBy: null,
        ...over,
    };
}

function search(bandId: string, total: number, planned: number, error: string | null = null): UiSearch {
    return { bandId: bandId, option: 'chaos', total: total, fetchPlanned: planned, complexity: 150, error: error };
}

test('good finds: floors pass and at least the minimum gain, best first then cheaper', () => {
    const items: UiItem[] = [
        item('a', 2),
        item('b', 0.5),
        item('c', 5, { floorsPass: false }),
        item('d', 2, { chaos: 1, price: { amount: 1, currency: 'chaos' } }),
        item('e', null),
    ];
    assert.deepEqual(
        goodFinds(items, 1).map((i) => i.id),
        ['d', 'a'],
    );
    assert.deepEqual(liveFiltered(items, 1), { floor: 1, sideGrade: 2, total: 3 });
});

test('bands: done, the one searching, waiting; refused when every search failed', () => {
    const snap: RunSnapshot = {
        header: header,
        phase: 'searching',
        searches: [search('b0', 40, 20), search('b1', 900, 20)],
        items: [item('a', 2), item('x', 1, { bandId: 'b1' })],
        bandsDone: ['b0'],
        feed: [],
        summary: null,
    };
    const rows = bandRows(snap);
    assert.deepEqual(
        rows.map((r) => r.status),
        ['done', 'searching', 'waiting'],
    );
    assert.deepEqual(
        rows.map((r) => r.matches),
        [40, 900, null],
    );
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
    const counts = hiddenCounts([
        item('a', 1, { hidden: 'floor' }),
        item('b', 1, { hidden: 'floor' }),
        item('c', 1, { hidden: 'dominated' }),
        item('d', 1),
    ]);
    assert.equal(counts.get('floor'), 2);
    assert.equal(counts.get('dominated'), 1);
    assert.equal(counts.get('low-gain'), undefined);
});

test('band matches flag the site cap of 10,000 per search; the blend reads as DPS + EHP', () => {
    const snap: RunSnapshot = {
        header: header,
        phase: 'done',
        searches: [search('b0', 10000, 50), search('b0', 9000, 50), search('b1', 671, 100)],
        items: [],
        bandsDone: ['b0', 'b1'],
        feed: [],
        summary: null,
    };
    const rows = bandRows(snap);
    assert.deepEqual(
        rows.map((r) => [r.matches, r.matchesCapped, r.planned]),
        [
            [19000, true, 100],
            [671, false, 100],
            [null, false, 0],
        ],
    );
    assert.equal(blendText(0.5), 'DPS 50% + EHP 50%');
    assert.equal(blendText(0.7), 'DPS 70% + EHP 30%');
});

test('plan chip: all met, some missed, or not checked; none without checks', () => {
    const check = (status: 'met' | 'missed' | 'unknown') => ({
        kind: 'include' as const,
        label: 'x',
        status: status,
        value: null,
        lines: [],
    });
    assert.equal(planChip([]), null);
    assert.deepEqual(planChip([check('met'), check('met')]), { text: 'Plan ✓', status: 'met' });
    assert.deepEqual(planChip([check('met'), check('missed'), check('unknown')]), { text: 'Plan: 1 missed', status: 'missed' });
    assert.deepEqual(planChip([check('met'), check('unknown')]), { text: 'Plan: not checked', status: 'unknown' });
    assert.equal(planCheckText({ kind: 'exclude', label: 'rarity', status: 'met', value: null, lines: [] }), '✓ none of: rarity');
    assert.equal(
        planCheckText({ kind: 'include', label: 'life (≥ 70)', status: 'missed', value: 'total 60', lines: [] }),
        '✗ life (≥ 70): total 60',
    );
});

test("a plan check's chip value: a defence's at-20% figure, a total without its word", () => {
    const check = (kind: 'include' | 'defence', value: string | null) => ({
        kind: kind,
        label: 'x',
        status: 'met' as const,
        value: value,
        lines: [],
    });
    assert.equal(chipValue(check('defence', '531 listed at 18% quality, 540 at 20%')), '540');
    assert.equal(chipValue(check('defence', '886 at 20% quality')), '886');
    assert.equal(chipValue(check('include', 'total 32')), '32');
    assert.equal(chipValue(check('include', null)), null);
});

test('an empty slot reads as one, not "your nothing" (issue #33)', () => {
    const h = { currentView: null, currentItem: 'nothing' } as unknown as RunHeader;
    assert.equal(slotWasEmpty(h), true);
    assert.equal(currentItemText(h), 'an empty slot');
    const worn = { currentView: null, currentItem: 'Gale Talons, Leviathan Gauntlets' } as unknown as RunHeader;
    assert.equal(currentItemText(worn), 'your Gale Talons, Leviathan Gauntlets');
});

test('skipped listings by reason (#39)', () => {
    assert.equal(skippedText({ 'not-for-slot': 0, unidentified: 0, 'already-fetched': 0, malformed: 0, 'excluded-mod': 0 }), null);
    assert.equal(
        skippedText({ 'not-for-slot': 10, unidentified: 2, 'already-fetched': 0, malformed: 1, 'excluded-mod': 0 }),
        "13 skipped: 10 PoB won't equip in the slot, 2 unidentified, 1 couldn't be read.",
    );
});

test('listings dropped for an excluded hybrid name the mod, each with its count when there are several (#38)', () => {
    const esMana: string = '+# to maximum Energy Shield / +# to maximum Mana';
    const esLife: string = '+# to maximum Energy Shield / +# to maximum Life';
    const none = { 'not-for-slot': 0, unidentified: 0, 'already-fetched': 0, malformed: 0 } as const;
    assert.equal(
        skippedText({ ...none, 'excluded-mod': 8 }, [{ name: esMana, dropped: 8 }]),
        `8 skipped: 8 had an excluded mod (${esMana}).`,
    );
    assert.equal(
        skippedText({ ...none, unidentified: 1, 'excluded-mod': 15 }, [
            { name: esMana, dropped: 8 },
            { name: esLife, dropped: 7 },
        ]),
        `16 skipped: 1 unidentified, 15 had an excluded mod (${esMana}: 8; ${esLife}: 7).`,
    );
});

const KAOM_TEXT: string = "Rarity: Unique\nKaom's Roots\nTitan Greaves\n--------\n+200 to maximum Life\nUnwavering Stance\n";

test('foldCopies: copies with the same text but other prices and notes fold into the cheapest', () => {
    const a = item('a', 1, { text: `${KAOM_TEXT}--------\nNote: ~b/o 9 chaos\n`, chaos: 9 });
    const b = item('b', 1, { text: `${KAOM_TEXT}--------\nNote: ~price 4 chaos\n`, chaos: 4 });
    const c = item('c', 1, { text: `${KAOM_TEXT}\n\n`, chaos: 6 });
    const folded: FoldedItem[] = foldCopies([a, b, c]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0]?.item.id, 'b');
    assert.equal(folded[0]?.copies, 2);
    assert.equal(folded[0]?.fromChaos, 4);
});

test('foldCopies: one different line keeps them apart, in the order they came', () => {
    const a = item('a', 1, { text: KAOM_TEXT, chaos: 9 });
    const b = item('b', 1, { text: KAOM_TEXT.replace('+200', '+199'), chaos: 4 });
    assert.deepEqual(
        foldCopies([a, b]).map((f) => [f.item.id, f.copies]),
        [
            ['a', 0],
            ['b', 0],
        ],
    );
});

test('foldCopies: an unpriced copy is never shown over a priced one; a preferred copy is', () => {
    const a = item('a', 1, { text: KAOM_TEXT, chaos: null });
    const b = item('b', 1, { text: KAOM_TEXT, chaos: 7 });
    assert.equal(foldCopies([a, b])[0]?.item.id, 'b');
    const c = item('c', 1, { text: KAOM_TEXT, chaos: 3 });
    assert.equal(foldCopies([b, c], new Set(['b']))[0]?.item.id, 'b');
});

test('foldCopies: "from" is the cheapest copy, even when a pricier tagged copy is shown', () => {
    const tagged = item('t', 1, { text: KAOM_TEXT, chaos: 9 });
    const cheap = item('c', 1, { text: KAOM_TEXT, chaos: 3 });
    const f = foldCopies([tagged, cheap], new Set(['t']))[0];
    assert.equal(f?.item.id, 't');
    assert.equal(f?.fromChaos, 3);
});
