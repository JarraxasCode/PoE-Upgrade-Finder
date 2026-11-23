// Slot data for the slot plan tests, in the checked shape (engine-client's SlotData). Boots, made up but shaped
// like PoB's: hybrids that share a stat with a pure mod, a "reduced" suffix, rarity on both sides, a group with
// two different stats, influence pools, and eldritch implicits.

import type { SlotBase, SlotData, SlotFamily, SlotMod, SlotModType } from '@poe-upgrade-finder/engine-client';
import { priceBands } from '../src/bands.ts';
import { DEFAULT_FLOORS } from '../src/floors.ts';
import type { PobTradeQuery, RunContext } from '../src/spec.ts';
import { baseStats } from './fixtures.ts';

export const S = {
    ms: 'explicit.stat_ms',
    es: 'explicit.stat_es',
    sr: 'explicit.stat_sr',
    life: 'explicit.stat_life',
    lifeRegen: 'explicit.stat_liferegen',
    mana: 'explicit.stat_mana',
    flatEs: 'explicit.stat_flates',
    fire: 'explicit.stat_fire',
    cold: 'explicit.stat_cold',
    chaos: 'explicit.stat_chaos',
    attrReq: 'explicit.stat_attrreq',
    rarity: 'explicit.stat_rarity',
    evasion: 'explicit.stat_evasion',
    shaper: 'explicit.stat_shaper',
    elder: 'explicit.stat_elder',
    crusader: 'explicit.stat_crusader',
    exarchA: 'implicit.stat_exarcha',
    exarchB: 'implicit.stat_exarchb',
    eater: 'implicit.stat_eater',
    fireCold: 'implicit.stat_firecold',
    chaosImplicit: 'implicit.stat_chaos',
} as const;

interface FamilySpec {
    readonly name: string;
    readonly type: SlotModType;
    readonly group: string;
    /** [id, PoB's line with #, site text, range, negate] per stat. */
    readonly stats: readonly (readonly [string, string, string, readonly [number, number], boolean?])[];
}

const FAMILIES: readonly FamilySpec[] = [
    {
        name: 'MS',
        type: 'Prefix',
        group: 'MovementVelocity',
        stats: [[S.ms, '#% increased Movement Speed', '#% increased Movement Speed', [10, 35]]],
    },
    {
        name: 'ES',
        type: 'Prefix',
        group: 'LocalEnergyShieldPercent',
        stats: [[S.es, '#% increased Energy Shield', '#% increased Energy Shield (Local)', [11, 100]]],
    },
    {
        name: 'ESSR',
        type: 'Prefix',
        group: 'LocalEnergyShieldAndStunRecoveryPercent',
        stats: [
            [S.es, '#% increased Energy Shield', '#% increased Energy Shield (Local)', [6, 42]],
            [S.sr, '#% increased Stun and Block Recovery', '#% increased Stun and Block Recovery', [6, 17]],
        ],
    },
    { name: 'LIFE', type: 'Prefix', group: 'IncreasedLife', stats: [[S.life, '+# to maximum Life', '+# to maximum Life', [3, 99]]] },
    {
        name: 'LIFEREGEN',
        type: 'Prefix',
        group: 'IncreasedLife',
        stats: [[S.lifeRegen, '# Life Regeneration per second', '# Life Regeneration per second', [1, 8]]],
    },
    { name: 'MANA', type: 'Prefix', group: 'IncreasedMana', stats: [[S.mana, '+# to maximum Mana', '+# to maximum Mana', [15, 73]]] },
    {
        name: 'ESMANA',
        type: 'Prefix',
        group: 'LocalEnergyShieldAndManaPercent',
        stats: [
            [S.es, '#% increased Energy Shield', '#% increased Energy Shield (Local)', [11, 30]],
            [S.mana, '+# to maximum Mana', '+# to maximum Mana', [17, 30]],
        ],
    },
    {
        name: 'FLATES',
        type: 'Prefix',
        group: 'LocalEnergyShield',
        stats: [[S.flatEs, '+# to maximum Energy Shield', '+# to maximum Energy Shield (Local)', [3, 50]]],
    },
    {
        name: 'RARP',
        type: 'Prefix',
        group: 'ItemFoundRarityIncreasePrefix',
        stats: [[S.rarity, '#% increased Rarity of Items found', '#% increased Rarity of Items found', [8, 24]]],
    },
    {
        name: 'FIRE',
        type: 'Suffix',
        group: 'FireResistance',
        stats: [[S.fire, '+#% to Fire Resistance', '+#% to Fire Resistance', [6, 48]]],
    },
    {
        name: 'COLD',
        type: 'Suffix',
        group: 'ColdResistance',
        stats: [[S.cold, '+#% to Cold Resistance', '+#% to Cold Resistance', [6, 48]]],
    },
    {
        name: 'CHAOS',
        type: 'Suffix',
        group: 'ChaosResistance',
        stats: [[S.chaos, '+#% to Chaos Resistance', '+#% to Chaos Resistance', [5, 35]]],
    },
    {
        name: 'SR',
        type: 'Suffix',
        group: 'StunRecovery',
        stats: [[S.sr, '#% increased Stun and Block Recovery', '#% increased Stun and Block Recovery', [11, 28]]],
    },
    {
        name: 'AR',
        type: 'Suffix',
        group: 'LocalAttributeRequirements',
        stats: [[S.attrReq, '#% reduced Attribute Requirements', '#% increased Attribute Requirements', [-32, -18], true]],
    },
    {
        name: 'RARS',
        type: 'Suffix',
        group: 'ItemFoundRarityIncrease',
        stats: [[S.rarity, '#% increased Rarity of Items found', '#% increased Rarity of Items found', [6, 26]]],
    },
    {
        name: 'EV',
        type: 'Prefix',
        group: 'LocalEvasionRatingIncreasePercent',
        stats: [[S.evasion, '#% increased Evasion Rating', '#% increased Evasion Rating (Local)', [15, 100]]],
    },
    {
        name: 'SHAPER',
        type: 'Suffix',
        group: 'ShaperSuffix',
        stats: [[S.shaper, '#% chance to Avoid being Stunned', '#% chance to Avoid being Stunned', [10, 20]]],
    },
    { name: 'ELDER', type: 'Suffix', group: 'ElderSuffix', stats: [[S.elder, '#% chance to Dodge', '#% chance to Dodge', [3, 6]]] },
    {
        name: 'CRUSADER',
        type: 'Suffix',
        group: 'CrusaderSuffix',
        stats: [[S.crusader, '#% Chance to Block', '#% Chance to Block', [2, 4]]],
    },
    { name: 'EXARCHA', type: 'Exarch', group: 'ExarchA', stats: [[S.exarchA, '#% increased Damage', '#% increased Damage', [5, 12]]] },
    { name: 'EXARCHB', type: 'Exarch', group: 'ExarchB', stats: [[S.exarchB, '#% increased Speed', '#% increased Speed', [2, 6]]] },
    { name: 'EATER', type: 'Eater', group: 'EaterA', stats: [[S.eater, '#% more Life', '#% more Life', [1, 3]]] },
    // A corrupted implicit in the same group as the chaos res suffix, as PoB has it (issue #30).
    {
        name: 'CORRCHAOS',
        type: 'Corrupted',
        group: 'ChaosResistance',
        stats: [[S.chaosImplicit, '+#% to Chaos Resistance', '+#% to Chaos Resistance', [7, 10]]],
    },
];

const SORCERER: readonly string[] = [
    'MS',
    'ES',
    'ESSR',
    'LIFE',
    'LIFEREGEN',
    'MANA',
    'ESMANA',
    'FLATES',
    'RARP',
    'FIRE',
    'COLD',
    'CHAOS',
    'SR',
    'AR',
    'RARS',
    'EXARCHA',
    'EXARCHB',
    'EATER',
    'CORRCHAOS',
];
const SLINK: readonly string[] = ['MS', 'LIFE', 'MANA', 'RARP', 'FIRE', 'COLD', 'CHAOS', 'SR', 'AR', 'RARS', 'EV'];

function families(): { readonly families: SlotFamily[]; readonly mods: Record<string, SlotMod> } {
    const out: SlotFamily[] = [];
    const mods: Record<string, SlotMod> = {};
    FAMILIES.forEach((f: FamilySpec, index: number) => {
        const modId: string = `${f.name}1`;
        out.push({
            type: f.type,
            group: f.group,
            source: 'natural',
            text: f.stats.map((s) => s[1]).join(' / '),
            tradeIds: f.stats.map((s) => s[0]),
            siteTexts: f.stats.map((s) => s[2]),
            tiers: [modId],
        });
        mods[modId] = {
            type: f.type,
            family: index,
            level: 1,
            lines: f.stats.map((s) => s[1]),
            via: 'hash',
            stats: f.stats.map((s, line: number) => ({ id: s[0], text: s[2], line: line, negate: s[4] === true, range: s[3] })),
        };
    });
    return { families: out, mods: mods };
}

function base(
    name: string,
    tradeType: string,
    defences: SlotBase['defences'],
    pools: SlotBase['pools'],
    implicits: SlotBase['implicits'] = [],
): SlotBase {
    return {
        name: name,
        tradeType: tradeType,
        subType: undefined,
        level: 60,
        tags: ['boots'],
        defences: defences,
        implicits: implicits,
        pools: pools,
    };
}

export function bootsData(): SlotData {
    const { families: fams, mods } = families();
    return {
        pobVersion: '2.68.1',
        baseType: 'Boots',
        bases: [
            base('Sorcerer Boots', 'Sorcerer Boots', { energyShield: [42, 51] }, { none: 0, shaper: 1, elder: 2, crusader: 3 }),
            base('Slink Boots', 'Slink Boots', { evasion: [228, 262] }, { none: 4 }),
            base('Two-Toned Boots (Armour/Evasion)', 'Two-Toned Boots', { armour: [126, 145], evasion: [126, 145] }, { none: 4 }, [
                {
                    modId: 'TwoTonedImplicit',
                    lines: ['+(8-12)% to Fire and Cold Resistances'],
                    stats: [{ id: S.fireCold, text: '+#% to Fire and Cold Resistances', line: 0, negate: false, range: [8, 12] }],
                },
            ]),
        ],
        pools: [SORCERER.map((n: string) => `${n}1`), ['SHAPER1'], ['ELDER1'], ['CRUSADER1'], SLINK.map((n: string) => `${n}1`)],
        families: fams,
        mods: mods,
        unmatched: [],
        seconds: 0.1,
    };
}

/** A Boots run's context with PoB's weights on these stats (weights in this order). */
export function bootsContext(weights: readonly (readonly [string, number])[]): RunContext {
    const pobQuery: PobTradeQuery = {
        category: { query: 'armour.boots' },
        query: { stats: [{ type: 'weight', filters: weights.map(([id, weight]) => ({ id: id, weight: weight })) }] },
    };
    return {
        slot: 'Boots',
        listingType: 'securable',
        priceBands: priceBands(300),
        characterLevel: 94,
        baseline: baseStats(),
        stripped: baseStats(),
        pobQuery: pobQuery,
        floors: DEFAULT_FLOORS,
    };
}
