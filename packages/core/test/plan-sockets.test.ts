// The slot plan's socket filters (#58): the spec, the site's socket filters and their cost (V30).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UniqueInfo } from '@poe-upgrade-finder/engine-client';
import type { PlanSockets, SlotPlan } from '@poe-upgrade-finder/vocab';
import type { BandSearch } from '../src/bands.ts';
import { isEmptyPlan } from '../src/plan.ts';
import { compileQuery, predictComplexity } from '../src/query-compiler.ts';
import { buildSlotSpec, socketFilters } from '../src/slot-spec.ts';
import type { SlotSpecResult } from '../src/slot-spec.ts';
import { saveSpec } from '../src/spec.ts';
import type { SlotSearchSpec } from '../src/spec.ts';
import { bootsContext, bootsData } from './plan-fixtures.ts';

const SEARCH: BandSearch = { bandId: 'band-2', option: 'chaos', price: { min: 1, max: 33.33, option: 'chaos' } };
const SOCKETS: PlanSockets = { links: { min: 6, max: 6 }, sockets: { r: 3 } };
const KAOM_PICK = { name: "Kaom's Roots", base: 'Titan Greaves', tradeType: 'Titan Greaves' } as const;

function kaom(): UniqueInfo {
    return {
        name: "Kaom's Roots",
        base: 'Titan Greaves',
        tradeType: 'Titan Greaves',
        variant: 1,
        variants: 1,
        scoreLow: 1,
        scoreMid: 1,
        scoreHigh: 1,
        change: 0,
        weights: [],
        rolls: [],
        statIds: [],
        unmatched: [],
    };
}

function specOf(p: SlotPlan, unique?: UniqueInfo): SlotSearchSpec {
    const result: SlotSpecResult = buildSlotSpec(p, {
        context: bootsContext([]),
        slotData: bootsData(),
        ...(unique === undefined ? {} : { unique: unique }),
    });
    if (!result.ok) {
        assert.fail(`refused: ${result.check.problems.map((x) => x.text).join('; ')}`);
    }
    return result.spec;
}

function rare(sockets: PlanSockets): SlotPlan {
    return { slot: 'Boots', itemType: null, base: null, picks: [], sockets: sockets };
}

test('socket filters label each row: range, then colours in R G B W order', () => {
    assert.deepEqual(
        socketFilters(rare({ sockets: { min: 6, max: 6 }, links: { min: 5, r: 3 } })).map((s) => s.label),
        ['Sockets 6, from plan', 'Links ≥ 5, 3 R, from plan'],
    );
    assert.deepEqual(
        socketFilters(rare({ links: { w: 1, r: 3 } })).map((s) => s.label),
        ['Links 3 R 1 W, from plan'],
    );
    assert.deepEqual(
        socketFilters(rare({ sockets: { min: 4, max: 5 }, links: { max: 4 } })).map((s) => s.label),
        ['Sockets 4 to 5, from plan', 'Links ≤ 4, from plan'],
    );
    assert.deepEqual(socketFilters(rare({ links: {} })), []);
});

test('a rare plan with socket filters sends socket_filters, 2 complexity per row (V30)', () => {
    const spec: SlotSearchSpec = specOf(rare(SOCKETS));
    assert.deepEqual(
        spec.sockets.map((s) => [s.row, s.range]),
        [
            ['sockets', { r: 3 }],
            ['links', { min: 6, max: 6 }],
        ],
    );
    const q = compileQuery(spec, SEARCH);
    assert.deepEqual(q.body.query.filters.socket_filters, { filters: { sockets: { r: 3 }, links: { min: 6, max: 6 } } });
    assert.equal(q.complexity - compileQuery(specOf(rare({})), SEARCH).complexity, 4);
    assert.equal(predictComplexity(0, 0, { excluded: 0, typed: false, influences: 0, sockets: 1 }) - predictComplexity(0, 0), 2);
    assert.deepEqual(saveSpec(spec).sockets, spec.sockets);
});

test('no socket filter sends no socket_filters', () => {
    assert.equal(compileQuery(specOf(rare({})), SEARCH).body.query.filters.socket_filters, undefined);
});

test('a unique plan carries its socket filters into the search', () => {
    const p: SlotPlan = { slot: 'Boots', itemType: 'Boots', base: null, picks: [], unique: KAOM_PICK, sockets: { links: { min: 6 } } };
    const spec: SlotSearchSpec = specOf(p, kaom());
    assert.deepEqual(
        spec.sockets.map((s) => s.label),
        ['Links ≥ 6, from plan'],
    );
    assert.deepEqual(compileQuery(spec, SEARCH).body.query.filters.socket_filters, { filters: { links: { min: 6 } } });
});

test('a plan with only socket filters is not empty', () => {
    assert.equal(isEmptyPlan(rare({ links: { min: 6 } })), false);
    assert.equal(isEmptyPlan(rare({ links: {} })), true);
});
