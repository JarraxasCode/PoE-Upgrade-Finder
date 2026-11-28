import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceBands } from '../src/bands.ts';
import type { PriceBand } from '../src/bands.ts';
import { evaluateItem } from '../src/evaluate.ts';
import type { EvaluatedItem } from '../src/evaluate.ts';
import { DEFAULT_FLOORS } from '../src/floors.ts';
import { junkFilter } from '../src/junk.ts';
import type { FilteredItem } from '../src/junk.ts';
import { valuePick } from '../src/value-rule.ts';
import type { Verdict } from '../src/value-rule.ts';
import { baseStats, emptyPlanSpec, evaluated, listed } from './fixtures.ts';

const BANDS: readonly PriceBand[] = priceBands(300);

function hidden(rows: readonly FilteredItem[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rows) {
        out[r.evaluated.item.id] = r.hidden ?? 'shown';
    }
    return out;
}

test('evaluateItem runs the checks and the gain on PoB numbers', () => {
    const spec = emptyPlanSpec({
        slot: 'Boots',
        listingType: 'securable',
        priceBands: priceBands(300),
        characterLevel: 94,
        baseline: baseStats(),
        stripped: baseStats(),
        pobQuery: { category: { query: 'armour.boots' }, query: { stats: [] } },
        floors: DEFAULT_FLOORS,
    });
    const after = { damage: 1_020_000, values: { ...baseStats().values, TotalEHP: 101_000, ChaosResist: 45 } };
    const e: EvaluatedItem = evaluateItem(spec, baseStats(), listed('a', 10), { stats: after, unparsed: [] }, 0.5);
    assert.ok(Math.abs(e.gain.gain - 1.5) < 1e-9, `gain ${e.gain.gain}`);
    assert.equal(e.floorsPass, false);
    assert.deepEqual(
        e.failedFloors.map((c) => c.checkId),
        ['chaos-res'],
    );
    assert.deepEqual(
        e.missedTargets.map((c) => c.checkId),
        ['target-chaos-res', 'target-max-res-fire'],
    );
});

test('junk filter: floors, missing gain, low gain, duplicates by one seller, dominated', () => {
    const rows: FilteredItem[] = junkFilter([
        evaluated(listed('floor', 5), 9, false),
        evaluated(listed('nan', 5), Number.NaN),
        evaluated(listed('low', 2), 0.5),
        evaluated(listed('cheap', 5), 3),
        evaluated(listed('dear-dup', 20, { seller: 'S', text: 'same' }), 6),
        evaluated(listed('cheap-dup', 15, { seller: 'S', text: 'same' }), 6),
        evaluated(listed('dominated', 30), 4),
        evaluated(listed('best', 50), 8),
        evaluated(listed('exalt', undefined), 2),
    ]);
    assert.deepEqual(hidden(rows), {
        floor: 'floor',
        nan: 'no-gain',
        low: 'low-gain',
        cheap: 'shown',
        'dear-dup': 'duplicate',
        'cheap-dup': 'shown',
        dominated: 'dominated',
        best: 'shown',
        exalt: 'shown',
    });
    assert.equal(rows.find((r: FilteredItem) => r.evaluated.item.id === 'dominated')?.hiddenBy, 'cheap-dup');
    assert.equal(rows.find((r: FilteredItem) => r.evaluated.item.id === 'dear-dup')?.hiddenBy, 'cheap-dup');
});

test('value rule: the cheapest item with at least 80% of the best gain', () => {
    const rows: FilteredItem[] = junkFilter([
        evaluated(listed('best', 90, { bandId: 'band-3' }), 10),
        evaluated(listed('eighty', 40, { bandId: 'band-3' }), 8),
        evaluated(listed('cheap', 5), 7.9),
        evaluated(listed('over', 350, { bandId: 'over' }), 14),
        evaluated(listed('broken', 1, { bandId: 'band-1' }), 20, false),
    ]);
    const v: Verdict = valuePick(rows);
    assert.equal(v.kind, 'pick');
    assert.ok(v.kind === 'pick');
    assert.equal(v.pick.item.id, 'eighty');
    assert.equal(v.best.item.id, 'best');
    assert.match(v.note, /at least 80% of the best/);
    assert.deepEqual(
        v.overBudget.map((e: EvaluatedItem) => e.item.id),
        ['over'],
        'over budget is noted, never picked',
    );
});

test('value rule: ties on price go to the higher gain; a lone best is its own pick', () => {
    const tie: Verdict = valuePick(
        junkFilter([evaluated(listed('a', 10), 9), evaluated(listed('b', 10), 9.5), evaluated(listed('top', 30), 10)]),
    );
    assert.ok(tie.kind === 'pick' && tie.pick.item.id === 'b');
    const lone: Verdict = valuePick(junkFilter([evaluated(listed('only', 10), 3)]));
    assert.ok(lone.kind === 'pick' && lone.pick.item.id === 'only' && /the best in budget/.test(lone.note));
});

test('value rule: no upgrade when the best is under the minimum, or nothing passes', () => {
    const low: Verdict = valuePick(junkFilter([evaluated(listed('a', 10), 0.6)]));
    assert.equal(low.kind, 'no-upgrade');
    assert.match(low.note, /under the \+1% minimum/);
    const none: Verdict = valuePick(junkFilter([evaluated(listed('a', 10), 5, false)]));
    assert.equal(none.kind, 'no-upgrade');
    assert.equal(none.best, undefined);
    // 80% of 1.1 is under the minimum: only items at the minimum or above can be the pick.
    const edge: Verdict = valuePick(junkFilter([evaluated(listed('top', 30), 1.1), evaluated(listed('cheap', 2), 0.9)]));
    assert.ok(edge.kind === 'pick' && edge.pick.item.id === 'top');
});

test('the no-upgrade note names its cause, not always the floors (issue #72)', () => {
    const note = (items: readonly FilteredItem[], listings: number, stoppedReason?: string): string =>
        valuePick(items, {}, { listings: listings, stoppedReason: stoppedReason }).note;
    assert.equal(note([], 0), 'No upgrade found: no listings in budget matched the search.');
    assert.equal(note([], 12), 'No upgrade found: none of the 12 listings in budget could be scored (the run summary says why).');
    assert.equal(note([], 12, 'Cancelled.'), 'No upgrade found: the run stopped before anything in budget was scored (Cancelled).');
    const failing: FilteredItem[] = junkFilter([evaluated(listed('a', 10), 5, false), evaluated(listed('b', 20), 3, false)]);
    assert.equal(note(failing, 2), 'No upgrade found: all 2 items scored in budget failed a floor.');
    assert.equal(note(failing.slice(0, 1), 1), 'No upgrade found: the one item scored in budget failed a floor.');
    const mixed: FilteredItem[] = junkFilter([
        evaluated(listed('a', 10), 5, false),
        evaluated(listed('b', 20), Number.NaN),
        evaluated(listed('c', undefined), 4),
    ]);
    assert.equal(
        note(mixed, 3),
        'No upgrade found: of the 3 items scored in budget, 1 failed a floor, 1 had no gain figure, 1 had no chaos price.',
    );
    // Only the over-budget band scored: nothing in budget was.
    const over: PriceBand | undefined = BANDS.find((b: PriceBand) => b.role === 'over');
    assert.ok(over !== undefined);
    const onlyOver: FilteredItem[] = junkFilter([evaluated(listed('x', 400, { bandId: over.id }), 5)]);
    assert.equal(note(onlyOver, 0), 'No upgrade found: no listings in budget matched the search.');
    // Without the run's outcome (a caller that has none), it says only that nothing in budget was scored.
    assert.equal(valuePick([]).note, 'No upgrade found: nothing in budget was scored.');
});

test('an empty run names what narrowed the search and what to try (#34)', () => {
    const empty = (causes: readonly string[], over: number, stoppedReason?: string): string =>
        valuePick([], {}, { listings: 0, stoppedReason: stoppedReason, causes: causes, overBudgetListings: over }).note;
    assert.equal(
        empty(['chaos res ≥ 22 (from a floor in Settings)', 'Links ≥ 6'], 0),
        'No upgrade found: no listings in budget matched the search. What narrowed it: chaos res ≥ 22 (from a floor in Settings); ' +
            'Links ≥ 6. Try a bigger budget, or loosening one of these.',
    );
    assert.equal(
        empty(['Links ≥ 6'], 7),
        'No upgrade found: no listings in budget matched the search. 7 listings just over budget did. ' +
            'What narrowed it: Links ≥ 6. Try a bigger budget, or loosening one of these.',
    );
    assert.equal(
        empty([], 1),
        'No upgrade found: no listings in budget matched the search. 1 listing just over budget did. ' + 'Try a bigger budget.',
    );
    // A stopped run: the stop is the cause, not the search.
    assert.equal(
        empty(['Links ≥ 6'], 0, 'Cancelled.'),
        'No upgrade found: the run stopped before anything in budget was scored (Cancelled).',
    );
});

test('an empty run never suggests whisper listings: they are the user own choice (#34)', () => {
    const note: string = valuePick([], {}, { listings: 0, stoppedReason: undefined, causes: ['Links ≥ 6'], overBudgetListings: 0 }).note;
    assert.doesNotMatch(note, /whisper|instant buyout/i);
});
