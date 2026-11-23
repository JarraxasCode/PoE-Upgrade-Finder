import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SLOT_ITEM_TYPES as CORE_SLOT_ITEM_TYPES } from '@poe-upgrade-finder/core';
import type { SlotPlan as CoreSlotPlan, WeightedStat } from '@poe-upgrade-finder/core';
import { readSlotData, SLOT_INFLUENCES as ENGINE_INFLUENCES } from '@poe-upgrade-finder/engine-client';
import type { SlotData, WithWarnings } from '@poe-upgrade-finder/engine-client';
import { readSlotEditorData, readSlotPlan, SLOT_INFLUENCES, SLOT_ITEM_TYPES } from '@poe-upgrade-finder/ipc';
import type { ModOption, SlotEditorData, SlotPlan } from '@poe-upgrade-finder/ipc';
import type { Logger } from '@poe-upgrade-finder/logging';
import { sampleSlotDataJson } from '../../../packages/engine-client/test/slotdata-sample.ts';
import { planReview } from '../src/run/slot-pipeline.ts';
import { isGearPseudo, SlotDataService, slotEditorData, totalOptions } from '../src/services/slot-data.ts';
import type { SlotDataCache } from '../src/services/slot-data.ts';

const quiet: Logger = {
    log(): void {
        // Tests don't read the service's log.
    },
};

function sample(): SlotData {
    return readSlotData(sampleSlotDataJson());
}

const MS: string = 'explicit.stat_2250533757';
const EV: string = 'explicit.stat_124859000';

const PLAN: SlotPlan = {
    slot: 'Boots',
    itemType: 'Boots',
    base: 'Sorcerer Boots',
    picks: [{ position: 'prefix', group: 'MovementVelocity', influence: 'none', rule: 'include', stats: [{ statId: MS, min: 20 }] }],
};

test("the ipc's plan mirrors core's: same influences, and a plan passes between them unchanged", () => {
    assert.deepEqual(SLOT_INFLUENCES, ENGINE_INFLUENCES);
    assert.deepEqual(SLOT_ITEM_TYPES, CORE_SLOT_ITEM_TYPES);
    // Both directions compile only while the two shapes match.
    const asCore: CoreSlotPlan = PLAN;
    const asIpc: SlotPlan = asCore;
    assert.deepEqual(readSlotPlan(asIpc, 'p'), PLAN);
});

test('the editor data: bases with their influences and implicits, mods with rolls as the mod reads', () => {
    const data: SlotEditorData = slotEditorData(sample(), 'Boots', 'Sorcerer Boots');
    // It passes the renderer's own check unchanged.
    assert.deepEqual(readSlotEditorData(JSON.parse(JSON.stringify(data)), 'd'), data);
    assert.deepEqual(
        data.bases.map((b) => [b.name, b.tradeType, b.influences]),
        [
            ['Sorcerer Boots', 'Sorcerer Boots', ['shaper']],
            ['Slink Boots', 'Slink Boots', ['shaper']],
            ['Two-Toned Boots (Armour/Evasion)', 'Two-Toned Boots', []],
        ],
    );
    assert.deepEqual(data.bases[2]?.implicits[0]?.stats[0]?.roll, [8, 12]);
    const byText = (text: string): ModOption | undefined => data.mods.find((m) => m.text === text);
    const ms: ModOption | undefined = byText('#% increased Movement Speed');
    assert.deepEqual(
        [ms?.position, ms?.group, ms?.influence, ms?.stats[0]?.roll, ms?.tiers.length],
        ['prefix', 'MovementVelocity', 'none', [10, 35], 2],
    );
    // "32% reduced Attribute Requirements" is -32 on the site; the editor shows it as it reads.
    const ar: ModOption | undefined = byText('#% reduced Attribute Requirements');
    assert.deepEqual(
        [ar?.position, ar?.stats[0]?.negate, ar?.stats[0]?.roll, ar?.stats[0]?.text, ar?.stats[0]?.siteText],
        ['suffix', true, [32, 32], '#% reduced Attribute Requirements', '#% increased Attribute Requirements'],
    );
    // A hybrid: each stat with its own words and roll.
    const hybrid: ModOption | undefined = byText('#% increased Energy Shield / #% increased Stun and Block Recovery');
    assert.deepEqual(
        hybrid?.stats.map((s) => [s.text, s.roll]),
        [
            ['#% increased Stun and Block Recovery', [16, 17]],
            ['#% increased Energy Shield', [39, 42]],
        ],
    );
    // Shaper mods are listed under their influence; evasion is a Slink Boots mod.
    assert.equal(data.mods.find((m) => m.influence === 'shaper')?.position, 'suffix');
    assert.equal(byText('#% increased Evasion Rating'), undefined);
    assert.ok(slotEditorData(sample(), 'Boots', null).mods.some((m) => m.text === '#% increased Evasion Rating'));
    assert.throws(() => slotEditorData(sample(), 'Boots', 'Iron Greaves'), /isn't a Boots base/);
});

test('slot data: one engine call per item type, then the cache; a failure is not remembered', async () => {
    const stored: Map<string, SlotData> = new Map<string, SlotData>();
    const cache: SlotDataCache = {
        slotData: (version: string, type: string) => stored.get(`${version}|${type}`),
        saveSlotData: (data: SlotData) => {
            stored.set(`${data.pobVersion}|${data.baseType}`, data);
        },
    };
    let calls: number = 0;
    let fail: boolean = true;
    const fetch = (): Promise<WithWarnings<SlotData>> => {
        calls += 1;
        if (fail) {
            return Promise.reject(new Error('engine down'));
        }
        return Promise.resolve({ ...sample(), warnings: [] });
    };
    const service: SlotDataService = new SlotDataService({ cache: cache, pobVersion: () => '2.68.1', fetch: fetch, logger: quiet });
    await assert.rejects(service.get('Boots'), /engine down/);
    fail = false;
    const [a, b] = await Promise.all([service.get('Boots'), service.get('Boots')]);
    assert.equal(calls, 2);
    assert.equal(a, b);
    assert.equal(Object.hasOwn(a, 'warnings'), false);
    // A new service (the app restarted) reads the cache.
    const again: SlotDataService = new SlotDataService({ cache: cache, pobVersion: () => '2.68.1', fetch: fetch, logger: quiet });
    assert.equal((await again.get('Boots')).baseType, 'Boots');
    assert.equal(calls, 2);
    // Another PoB version misses the cache.
    const newer: SlotDataService = new SlotDataService({ cache: cache, pobVersion: () => '2.69.0', fetch: fetch, logger: quiet });
    await newer.get('Boots');
    assert.equal(calls, 3);
});

test('the weight review: what the plan prunes, heaviest first, or why it cannot be searched', () => {
    const weights: readonly WeightedStat[] = [
        { statId: EV, weight: 1 },
        { statId: MS, weight: 3 },
        { statId: 'pseudo.pseudo_total_cold_resistance', weight: 2 },
    ];
    const label = (id: string): string => `name of ${id}`;
    const review = planReview(PLAN, sample(), weights, label);
    assert.deepEqual(
        review.pruned.map((p) => [p.statId, p.reason, p.label]),
        [
            [MS, 'included', `name of ${MS}`],
            [EV, 'base-cannot-roll', `name of ${EV}`],
        ],
    );
    assert.deepEqual(review.planProblems, []);
    const badBase = planReview({ ...PLAN, base: 'Iron Greaves' }, sample(), weights, label);
    assert.deepEqual(badBase.pruned, []);
    assert.match(badBase.planProblems[0] ?? '', /Iron Greaves isn't a Boots base/);
});

test('the Totals list: the measured pseudo totals first, then the rest of the site list (issue #26)', () => {
    const site = [
        { id: 'pseudo.pseudo_total_life', text: '+# total maximum Life', type: 'pseudo' },
        { id: 'pseudo.pseudo_number_of_empty_prefix_mods', text: '# Empty Prefix Modifiers', type: 'pseudo' },
        { id: 'explicit.stat_3299347043', text: '+# to maximum Life', type: 'explicit' },
    ];
    const data: SlotEditorData = slotEditorData(sample(), 'Boots', 'Sorcerer Boots', site);
    const life = data.totals.find((t) => t.id === 'pseudo.pseudo_total_life');
    assert.match(life?.counts ?? '', /half of the item's Strength/);
    assert.deepEqual(data.totals.at(-1), {
        id: 'pseudo.pseudo_number_of_empty_prefix_mods',
        text: '# Empty Prefix Modifiers',
        counts: null,
    });
    assert.equal(
        data.totals.some((t) => t.id.startsWith('explicit.')),
        false,
    );
    assert.ok(totalOptions([]).length > 10, 'without the site list, the measured ones');
});

test("the Totals list keeps the site's gear pseudo stats only: no maps, temple rooms, logbooks or Heist", () => {
    for (const id of [
        'pseudo.pseudo_total_life',
        'pseudo.pseudo_adds_fire_damage_to_attacks',
        'pseudo.pseudo_total_additional_gem_levels',
        'pseudo.pseudo_number_of_empty_prefix_mods',
        'pseudo.pseudo_has_shaper_influence',
        'pseudo.pseudo_searing_implicit_tier',
        'pseudo.pseudo_jewellery_resistance_quality',
    ]) {
        assert.equal(isGearPseudo(id), true, id);
    }
    for (const id of [
        'pseudo.pseudo_temple_tombs',
        'pseudo.pseudo_map_quality_rarity',
        'pseudo.pseudo_logbook_area_volcano',
        'pseudo.pseudo_ritual_unique_monsters',
        'pseudo.pseudo_lake_number_of_islands',
        'pseudo.lake_62572',
        'pseudo.pseudo_number_of_notable_passive_skills',
    ]) {
        assert.equal(isGearPseudo(id), false, id);
    }
});

test('a saved pick stat may still carry allSources (removed in #26): read and dropped; a non-boolean is refused', () => {
    const stats = (s: Record<string, unknown>): unknown => ({ ...PLAN, picks: [{ ...PLAN.picks[0], stats: [s] }] });
    assert.deepEqual(readSlotPlan(stats({ statId: MS, allSources: false }), 'p').picks[0]?.stats, [{ statId: MS }]);
    assert.throws(() => readSlotPlan(stats({ statId: MS, allSources: 'no' }), 'p'), /allSources/);
});

test('plan totals: pseudo ids only, read with their text and range', () => {
    const plan = { ...PLAN, totals: [{ statId: 'pseudo.pseudo_total_life', text: '+# total maximum Life', min: 80 }] };
    assert.deepEqual(readSlotPlan(plan, 'p').totals, plan.totals);
    assert.throws(() => readSlotPlan({ ...PLAN, totals: [{ statId: MS, text: 'x' }] }, 'p'), /not a pseudo stat id/);
});
