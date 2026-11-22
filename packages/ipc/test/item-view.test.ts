import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readItemDisplay } from '@poe-upgrade-finder/trade';
import { readItemView, readOptionalItemView } from '../src/item-view.ts';

const ITEM: unknown = {
    w: 2, h: 2, icon: 'https://web.poecdn.com/gen/image/abc/0c80b843d0/BootsDexInt3.png', name: 'Mind March', typeLine: "Assassin's Boots", rarity: 'Rare', ilvl: 85,
    properties: [{ name: 'Evasion Rating', values: [['233', 1]], displayMode: 0 }],
    explicitMods: [{ description: '+116 to maximum Life', domain: 'fractured' }],
};

test("the trade package's tooltip data passes the IPC check unchanged", () => {
    const display: unknown = JSON.parse(JSON.stringify(readItemDisplay(ITEM)));
    assert.deepEqual(readItemView(display, 'view'), display);
});

test('an icon from anywhere but the CDN is refused', () => {
    const display: Record<string, unknown> = { ...readItemDisplay(ITEM), icon: 'https://example.com/x.png' };
    assert.throws(() => readItemView(display, 'view'), /icons come from/);
});

test('a run saved before views existed reads as no view', () => {
    assert.equal(readOptionalItemView(undefined, 'view'), null);
});
