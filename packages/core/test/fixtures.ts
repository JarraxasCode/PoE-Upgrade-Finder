// Small hand-made stat blocks and items for the core tests.

import { NO_PLAN_MATCH } from '../src/plan-match.ts';
import type { EvaluatedItem } from '../src/evaluate.ts';
import type { Gain } from '../src/gain.ts';
import type { ListedItem } from '../src/spec.ts';
import type { PobStats } from '../src/stats.ts';

/** A build with every floor met: res capped at 75 with overcap, chaos 75, block 75, attributes met. */
export function baseStats(overrides: Readonly<Record<string, number | boolean>> = {}, damage: number = 1_000_000): PobStats {
    return {
        damage: damage,
        values: {
            TotalEHP: 100_000,
            Life: 7000,
            ChaosResist: 75,
            ChaosResistTotal: 80,
            MissingChaosResist: 0,
            FireResist: 89,
            MissingFireResist: 0,
            FireResistTotal: 140,
            FireResistOverCap: 51,
            ColdResist: 75,
            MissingColdResist: 0,
            ColdResistTotal: 130,
            ColdResistOverCap: 55,
            LightningResist: 75,
            MissingLightningResist: 0,
            LightningResistTotal: 120,
            LightningResistOverCap: 45,
            SpellBlockChance: 75,
            Str: 200,
            ReqStr: 155,
            Dex: 100,
            ReqDex: 98,
            Int: 150,
            ReqInt: 111,
            ...overrides,
        },
    };
}

export function listed(id: string, chaos: number | undefined, overrides: Partial<ListedItem> = {}): ListedItem {
    return {
        id: id,
        text: `Rarity: Rare\n${id}\nSorcerer Boots`,
        name: id,
        baseType: 'Sorcerer Boots',
        itemLevel: 84,
        statIds: [],
        seller: `seller-${id}`,
        price: chaos === undefined ? { amount: 3, currency: 'exalted', type: '~b/o' } : { amount: chaos, currency: 'chaos', type: '~b/o' },
        chaosEquivalent: chaos,
        bandId: 'band-2',
        ...overrides,
    };
}

/** An evaluated item with the given gain and floors, for the junk filter and value rule. */
export function evaluated(item: ListedItem, gainPct: number, floorsPass: boolean = true): EvaluatedItem {
    const gain: Gain = { dpsPct: gainPct, ehpPct: gainPct, gain: gainPct };
    const failed = floorsPass
        ? []
        : [{ checkId: 'chaos-res', kind: 'floor' as const, status: 'fail' as const, detail: 'Chaos res ≥ 50: 40 (was 75)' }];
    return {
        item: item,
        scored: { stats: baseStats(), unparsed: [] },
        gain: gain,
        checks: failed,
        notes: [],
        floorsPass: floorsPass,
        failedFloors: failed,
        missedTargets: [],
        flags: [],
        plan: NO_PLAN_MATCH,
    };
}
