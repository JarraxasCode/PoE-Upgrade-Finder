import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceBands } from '../src/bands.ts';
import type { PriceBand } from '../src/bands.ts';
import { evaluateItem } from '../src/evaluate.ts';
import type { EvaluatedItem } from '../src/evaluate.ts';
import { DEFAULT_FLOORS } from '../src/floors.ts';
import { junkFilter } from '../src/junk.ts';
import type { FilteredItem } from '../src/junk.ts';
import { v1SpecBuilder } from '../src/v1.ts';
import { valuePick } from '../src/value-rule.ts';
import type { Verdict } from '../src/value-rule.ts';
import { baseStats, evaluated, listed } from './fixtures.ts';

const BANDS: readonly PriceBand[] = priceBands(300);

function hidden(rows: readonly FilteredItem[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rows) {
        out[r.evaluated.item.id] = r.hidden ?? 'shown';
    }
    return out;
}

test('evaluateItem runs the checks and the gain on PoB numbers', () => {
    const spec = v1SpecBuilder().build({
        slot: 'Boots', listingType: 'securable', priceBands: priceBands(300), characterLevel: 94,
        baseline: baseStats(), stripped: baseStats(),
        pobQuery: { category: { query: 'armour.boots' }, query: { stats: [] } }, floors: DEFAULT_FLOORS,
    });
    const after = { damage: 1_020_000, values: { ...baseStats().values, TotalEHP: 101_000, ChaosResist: 45 } };
    const e: EvaluatedItem = evaluateItem(spec, baseStats(), listed('a', 10), { stats: after, unparsed: [] }, 0.5);
    assert.ok(Math.abs(e.gain.gain - 1.5) < 1e-9, `gain ${e.gain.gain}`);
    assert.equal(e.floorsPass, false);
    assert.deepEqual(e.failedFloors.map((c) => c.checkId), ['chaos-res']);
    assert.deepEqual(e.missedTargets.map((c) => c.checkId), ['target-chaos-res', 'target-max-res-fire']);
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
        floor: 'floor', nan: 'no-gain', low: 'low-gain', cheap: 'shown', 'dear-dup': 'duplicate', 'cheap-dup': 'shown',
        dominated: 'dominated', best: 'shown', exalt: 'shown',
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
    const v: Verdict = valuePick(rows, BANDS);
    assert.equal(v.kind, 'pick');
    assert.ok(v.kind === 'pick');
    assert.equal(v.pick.item.id, 'eighty');
    assert.equal(v.best.item.id, 'best');
    assert.match(v.note, /at least 80% of the best/);
    assert.deepEqual(v.overBudget.map((e: EvaluatedItem) => e.item.id), ['over'], 'over budget is noted, never picked');
});

test('value rule: ties on price go to the higher gain; a lone best is its own pick', () => {
    const tie: Verdict = valuePick(junkFilter([evaluated(listed('a', 10), 9), evaluated(listed('b', 10), 9.5), evaluated(listed('top', 30), 10)]), BANDS);
    assert.ok(tie.kind === 'pick' && tie.pick.item.id === 'b');
    const lone: Verdict = valuePick(junkFilter([evaluated(listed('only', 10), 3)]), BANDS);
    assert.ok(lone.kind === 'pick' && lone.pick.item.id === 'only' && /the best in budget/.test(lone.note));
});

test('value rule: no upgrade when the best is under the minimum, or nothing passes', () => {
    const low: Verdict = valuePick(junkFilter([evaluated(listed('a', 10), 0.6)]), BANDS);
    assert.equal(low.kind, 'no-upgrade');
    assert.match(low.note, /under the \+1% minimum/);
    const none: Verdict = valuePick(junkFilter([evaluated(listed('a', 10), 5, false)]), BANDS);
    assert.equal(none.kind, 'no-upgrade');
    assert.equal(none.best, undefined);
    // 80% of 1.1 is under the minimum: only items at the minimum or above can be the pick.
    const edge: Verdict = valuePick(junkFilter([evaluated(listed('top', 30), 1.1), evaluated(listed('cheap', 2), 0.9)]), BANDS);
    assert.ok(edge.kind === 'pick' && edge.pick.item.id === 'top');
});
