import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UiBand, UiItem } from '@poe-upgrade-finder/ipc';
import { bestPerBand, chartModel, gainAxisLow, linearAxis, logAxis, priceTick } from '../src/chart-model.ts';

function item(id: string, gain: number | null, chaos: number | null, over: Partial<UiItem> = {}): UiItem {
    return {
        id: id, name: id, baseType: 'Boots', itemLevel: 80, price: chaos === null ? null : { amount: chaos, currency: 'chaos' }, chaos: chaos, bandId: 'b0',
        gainPct: gain, dpsPct: gain, ehpPct: gain, floorsPass: true, failedFloors: [], flags: [], missedTargets: [], notes: [], unparsed: [], text: '', view: null, changes: [],
        hasBuyLink: true, hidden: null, hiddenBy: null, ...over,
    };
}

test('log price axis: padded past the data and the budget, 1-2-5 ticks, thinned when they would crowd', () => {
    const a = logAxis(5, 300);
    assert.ok(a.min < 5 && a.max > 300);
    assert.deepEqual(a.ticks, [5, 10, 20, 50, 100, 200]);
    const wide = logAxis(1, 3000);
    assert.ok(wide.ticks.length <= 7);
    assert.ok(wide.ticks.includes(1) && wide.ticks.includes(1000));
    assert.equal(priceTick(1500), '1.5k c');
    assert.equal(priceTick(33.333), '33.3c');
});

test('linear gain axis: clean steps that cover the range and include 0', () => {
    const a = linearAxis(-3, 4.5);
    assert.ok(a.min <= -3 && a.max >= 4.5);
    assert.ok(a.ticks.includes(0));
    const steps = a.ticks.slice(1).map((t, i) => t - (a.ticks[i] ?? 0));
    assert.ok(steps.every((s) => Math.abs(s - (steps[0] ?? 0)) < 1e-9));
});

test('chart: plots priced, scored items; clips gains below the axis floor; worth-a-look draws on top', () => {
    const items: UiItem[] = [
        item('worth', 2.2, 150),
        item('side', 0.4, 20, { hidden: 'low-gain' }),
        item('floor', 3, 40, { hidden: 'floor', floorsPass: false }),
        item('awful', -45, 10, { hidden: 'low-gain' }),
        item('noPrice', 1.5, null),
        item('noGain', null, 30, { hidden: 'no-gain' }),
        ...Array.from({ length: 10 }, (_v: unknown, i: number) => item(`fill${i}`, -1 - i / 10, 50 + i, { hidden: 'low-gain' })),
    ];
    const m = chartModel(items, { budgetChaos: 300, minGainPct: 1 });
    assert.ok(m !== null);
    assert.equal(m.points.length, 14);
    assert.equal(m.unplotted, 2);
    assert.equal(m.clipped, 1);
    assert.equal(m.y.min, -10);
    const awful = m.points.find((p) => p.item.id === 'awful');
    assert.equal(awful?.clipped, true);
    assert.equal(awful?.y, -10);
    assert.deepEqual(m.points.slice(-2).map((p) => p.kind), ['floor', 'worth']);
    assert.ok(m.x.max > 300);
    assert.equal(chartModel([item('x', null, null)], { budgetChaos: 300, minGainPct: 1 }), null);
});

test('gain axis floor: 0 or the lowest point above -10%; below that, only the worst ~10% get clipped', () => {
    assert.equal(gainAxisLow([1, 2, 3]), 0);
    assert.equal(gainAxisLow([-4, 2]), -4);
    assert.equal(gainAxisLow([-45, 1, 2, 3, 4, 5, 6, 7, 8, 9]), -10);
    const mostlyBad: number[] = Array.from({ length: 100 }, (_v: unknown, i: number) => -i / 2);
    const low: number = gainAxisLow(mostlyBad);
    assert.equal(mostlyBad.filter((g: number) => g < low).length <= 10, true);
});

test('best per band: highest gain passing the floors, even under the minimum; counts per band', () => {
    const bands: UiBand[] = [{ id: 'b0', label: 'up to 50c', role: 'main' }, { id: 'b1', label: '50c to 300c', role: 'main' }, { id: 'b2', label: 'over', role: 'over' }];
    const items: UiItem[] = [
        item('a', 0.5, 10, { hidden: 'low-gain' }),
        item('b', 9, 12, { floorsPass: false, hidden: 'floor' }),
        item('c', 2, 100, { bandId: 'b1' }),
        item('d', 3, 200, { bandId: 'b1' }),
        item('e', 5, 320, { bandId: 'b2', floorsPass: false, hidden: 'floor' }),
    ];
    const rows = bestPerBand(items, bands);
    assert.deepEqual(rows.map((r) => [r.best?.id ?? null, r.worth, r.scored]), [['a', 0, 2], ['d', 2, 2], [null, 0, 1]]);
});
