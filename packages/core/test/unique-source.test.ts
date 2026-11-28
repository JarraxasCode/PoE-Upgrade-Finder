import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UniqueInfo } from '@poe-upgrade-finder/engine-client';
import type { SlotPlan } from '@poe-upgrade-finder/vocab';
import { emptySlotPlan } from '@poe-upgrade-finder/vocab';
import { priceBands } from '../src/bands.ts';
import { DEFAULT_FLOORS } from '../src/floors.ts';
import { buildSlotSpec } from '../src/slot-spec.ts';
import type { SlotSpecResult } from '../src/slot-spec.ts';
import { saveSpec } from '../src/spec.ts';
import type { RunContext, SearchRequirement, SlotSearchSpec } from '../src/spec.ts';
import { uniqueNeedGaps } from '../src/unique-source.ts';
import { baseStats } from './fixtures.ts';

const LIFE: string = 'explicit.stat_3299347043';
const KAOM_PICK = { name: "Kaom's Roots", base: 'Titan Greaves', tradeType: 'Titan Greaves' } as const;

function kaom(weights: UniqueInfo['weights'] = [{ id: LIFE, weight: 0.33, line: '+(150-200) to maximum Life' }]): UniqueInfo {
    return {
        name: "Kaom's Roots",
        base: 'Titan Greaves',
        tradeType: 'Titan Greaves',
        variant: 2,
        variants: 2,
        scoreLow: 1405,
        scoreMid: 1413,
        scoreHigh: 1422,
        change: -78,
        weights: weights,
        rolls: [],
        statIds: ['explicit.stat_1493091477', LIFE, 'explicit.stat_4212255859'],
        unmatched: [],
        foulborn: null,
    };
}

// The build with its chaos res floor met only thanks to the boots: a strip hard need on total chaos res.
function context(): RunContext {
    return {
        slot: 'Boots',
        listingType: 'securable',
        priceBands: priceBands(300),
        characterLevel: 94,
        baseline: baseStats(),
        stripped: baseStats({ ChaosResist: 40, ChaosResistTotal: 45 }),
        pobQuery: {
            category: { query: 'armour.boots' },
            query: { stats: [{ type: 'weight', filters: [{ id: 'explicit.stat_9', weight: 5 }] }] },
        },
        floors: { ...DEFAULT_FLOORS, chaosResMin: 75 },
        weightEdits: { [LIFE]: { factor: 3 } },
    };
}

const UNIQUE_PLAN: SlotPlan = { slot: 'Boots', itemType: 'Boots', base: null, picks: [], unique: KAOM_PICK };

function spec(result: SlotSpecResult): SlotSearchSpec {
    assert.ok(result.ok, result.ok ? '' : result.check.problems.map((p) => p.text).join('; '));
    return result.spec;
}

test("a unique plan searches the unique by its own weights, with the strip's hard needs", () => {
    const rare: SlotSearchSpec = spec(buildSlotSpec(emptySlotPlan('Boots'), { context: context(), slotData: undefined }));
    const s: SlotSearchSpec = spec(buildSlotSpec(UNIQUE_PLAN, { context: context(), slotData: undefined, unique: kaom() }));
    assert.equal(s.rarity, 'unique');
    assert.deepEqual(s.unique, KAOM_PICK);
    assert.equal(s.category, 'armour.boots');
    // Only the unique's weight; the user's edits are for PoB's rare weights and don't apply.
    assert.deepEqual(s.weights, [{ statId: LIFE, weight: 0.33 }]);
    assert.ok(rare.requirements.length > 0);
    assert.deepEqual(s.requirements, rare.requirements);
    assert.equal(saveSpec(s).rarity, 'unique');
    assert.deepEqual(saveSpec(s).unique, KAOM_PICK);
});

test('a unique with nothing to weigh still gives a spec, with no weights', () => {
    const s: SlotSearchSpec = spec(buildSlotSpec(UNIQUE_PLAN, { context: context(), slotData: undefined, unique: kaom([]) }));
    assert.deepEqual(s.weights, []);
});

test('a rare plan searches rares, as before', () => {
    const s: SlotSearchSpec = spec(buildSlotSpec(emptySlotPlan('Boots'), { context: context(), slotData: undefined }));
    assert.equal(s.rarity, 'rare');
    assert.equal(s.unique, null);
    assert.deepEqual(saveSpec(s).unique, null);
});

test("a unique plan without PoB's data for that unique is refused", () => {
    // No data, another unique, or the same name on another base (several uniques share a name).
    for (const unique of [undefined, { ...kaom(), name: 'Atziri' + "'" + 's Step' }, { ...kaom(), base: 'Leviathan Greaves' }]) {
        const r: SlotSpecResult = buildSlotSpec(UNIQUE_PLAN, {
            context: context(),
            slotData: undefined,
            ...(unique === undefined ? {} : { unique: unique }),
        });
        assert.equal(r.ok, false);
        assert.match(r.check.problems.map((p) => p.text).join(' '), /PoB doesn't know that unique/);
    }
});

test('hard-need gaps: a need no line of the unique can carry', () => {
    const fire: SearchRequirement = { statId: 'pseudo.pseudo_total_fire_resistance', min: 30, origin: 'strip', label: 'fire res' };
    const life: SearchRequirement = { statId: 'pseudo.pseudo_total_life', min: 40, origin: 'strip', label: 'life' };
    assert.deepEqual(uniqueNeedGaps(kaom(), [fire, life]), [fire]);
    // A plain explicit requirement counts when the unique has that stat.
    assert.deepEqual(uniqueNeedGaps(kaom(), [{ statId: LIFE, min: 1, origin: 'strip', label: 'life line' }]), []);
});

test('a Foulborn version: the pick carries its mutated mod, and its mutated line is required', () => {
    const foul: UniqueInfo = {
        ...kaom([{ id: 'explicit.stat_4080418644', weight: 0.1, line: '+(150-200) to Strength' }]),
        foulborn: { modId: 'MutatedUniqueBootsStr2Strength', line: '+(150-200) to Strength', statId: 'explicit.stat_4080418644' },
    };
    const s: SlotSearchSpec = spec(
        buildSlotSpec(
            { ...UNIQUE_PLAN, unique: { ...KAOM_PICK, foulborn: 'MutatedUniqueBootsStr2Strength' } },
            {
                context: context(),
                slotData: undefined,
                unique: foul,
            },
        ),
    );
    assert.equal(s.unique?.foulborn, 'MutatedUniqueBootsStr2Strength');
    assert.deepEqual(
        s.requirements.filter((r) => r.origin === 'plan'),
        [{ statId: 'explicit.stat_4080418644', origin: 'plan', label: 'Required: Foulborn +(150-200) to Strength, from plan' }],
    );
    // The unique itself carries no Foulborn mod and needs no line.
    const plain: SlotSearchSpec = spec(buildSlotSpec(UNIQUE_PLAN, { context: context(), slotData: undefined, unique: kaom() }));
    assert.equal(plain.unique?.foulborn, undefined);
    assert.deepEqual(
        plain.requirements.filter((r) => r.origin === 'plan'),
        [],
    );
});
