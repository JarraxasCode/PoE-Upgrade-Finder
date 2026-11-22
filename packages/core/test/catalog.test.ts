import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStatList } from '@poe-upgrade-finder/trade';
import { ModCatalog } from '../src/catalog.ts';

// The shape of GET /api/trade/data/stats (groups by type; some entries carry an option list).
const RESPONSE: unknown = {
    result: [
        { id: 'pseudo', label: 'Pseudo', entries: [{ id: 'pseudo.pseudo_total_life', text: '+# total maximum Life', type: 'pseudo' }] },
        {
            id: 'explicit', label: 'Explicit', entries: [
                { id: 'explicit.stat_3299347043', text: '+# to maximum Life', type: 'explicit' },
                { id: 'explicit.stat_2563183002', text: 'Allocates #', type: 'explicit', option: { options: [{ id: 1, text: 'x' }] } },
                { text: 'no id: skipped', type: 'explicit' },
            ],
        },
    ],
};

test('stat list: entries read across groups; ones without an id are skipped; a wrong shape throws', () => {
    const entries = readStatList(RESPONSE);
    assert.deepEqual(entries.map((e) => e.id), ['pseudo.pseudo_total_life', 'explicit.stat_3299347043', 'explicit.stat_2563183002']);
    assert.throws(() => readStatList({ result: 'nope' }));
});

test('catalog: names stats, marks non-explicit types, unknown ids are undefined', () => {
    const catalog: ModCatalog = new ModCatalog(readStatList(RESPONSE));
    assert.equal(catalog.size, 3);
    assert.equal(catalog.describe('explicit.stat_3299347043'), '+# to maximum Life');
    assert.equal(catalog.describe('pseudo.pseudo_total_life'), '(pseudo) +# total maximum Life');
    assert.equal(catalog.describe('explicit.stat_0'), undefined);
    assert.equal(catalog.modsForSlot('Boots').length, 3);
});
