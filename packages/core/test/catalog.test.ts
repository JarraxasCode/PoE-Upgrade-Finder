import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStatList } from '@poe-upgrade-finder/trade';
import { readSlotData } from '@poe-upgrade-finder/engine-client';
import { ModCatalog } from '../src/catalog.ts';
import { sampleSlotDataJson } from '../../engine-client/test/slotdata-sample.ts';

// The shape of GET /api/trade/data/stats (groups by type; some entries carry an option list).
const RESPONSE: unknown = {
    result: [
        { id: 'pseudo', label: 'Pseudo', entries: [{ id: 'pseudo.pseudo_total_life', text: '+# total maximum Life', type: 'pseudo' }] },
        {
            id: 'explicit',
            label: 'Explicit',
            entries: [
                { id: 'explicit.stat_3299347043', text: '+# to maximum Life', type: 'explicit' },
                { id: 'explicit.stat_2563183002', text: 'Allocates #', type: 'explicit', option: { options: [{ id: 1, text: 'x' }] } },
                { text: 'no id: skipped', type: 'explicit' },
            ],
        },
    ],
};

test('stat list: entries read across groups; ones without an id are skipped; a wrong shape throws', () => {
    const entries = readStatList(RESPONSE);
    assert.deepEqual(
        entries.map((e) => e.id),
        ['pseudo.pseudo_total_life', 'explicit.stat_3299347043', 'explicit.stat_2563183002'],
    );
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

test('slot mods: per base, any base, and influence pools, with tiers and the bases that roll them', () => {
    const data = readSlotData(sampleSlotDataJson());
    const catalog = new ModCatalog([]).withSlotData(data);
    assert.equal(catalog.slotDataFor('Boots'), data);
    assert.deepEqual(catalog.slotMods('Ring', null), []);
    assert.deepEqual(catalog.slotMods('Boots', 'Nope Boots'), []);

    const sorcerer = catalog.slotMods('Boots', 'Sorcerer Boots');
    assert.deepEqual(
        sorcerer.map((c) => [c.family.group, c.influence, c.tiers.map((t) => t.modId)]),
        [
            ['LocalEnergyShieldPercent', 'none', ['ES1']],
            ['LocalEnergyShieldAndStunRecoveryPercent', 'none', ['ESSR1']],
            ['MovementVelocity', 'none', ['MS1', 'MS2']],
            ['LocalAttributeRequirements', 'none', ['AR1']],
        ],
    );

    const any = catalog.slotMods('Boots', null);
    const ms = any.find((c) => c.family.group === 'MovementVelocity');
    assert.deepEqual(
        ms?.tiers.map((t) => t.modId),
        ['MS1', 'MS2'],
    );
    assert.deepEqual(ms?.bases, ['Slink Boots', 'Sorcerer Boots', 'Two-Toned Boots (Armour/Evasion)']);
    const ev = any.find((c) => c.family.group === 'LocalEvasionRatingIncreasePercent');
    assert.deepEqual(ev?.bases, ['Slink Boots', 'Two-Toned Boots (Armour/Evasion)']);

    const shaper = catalog.slotMods('Boots', 'Two-Toned Boots (Armour/Evasion)', ['shaper']);
    assert.equal(
        shaper.some((c) => c.influence === 'shaper'),
        false,
        'this base has no shaper pool',
    );
    const withShaper = catalog.slotMods('Boots', 'Slink Boots', ['shaper']);
    assert.deepEqual(
        withShaper.filter((c) => c.influence === 'shaper').map((c) => c.tiers.map((t) => t.modId)),
        [['ShaperMS']],
    );
});
