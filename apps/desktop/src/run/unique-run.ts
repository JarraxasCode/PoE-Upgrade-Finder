// The parts of a unique run (#113) that differ from a rare one, before the first search: the picked unique from
// PoB's list, the header's notes on hard needs it can't carry, and what stands in for PoB's generator result.
// A unique run doesn't run the generator: its weights are the unique's own.

import { uniqueNeedGaps } from '@poe-upgrade-finder/core';
import type { SearchRequirement } from '@poe-upgrade-finder/core';
import type { EquippedItem, ItemInfo, TradeQueryData, UniqueInfo, UniquesData } from '@poe-upgrade-finder/engine-client';
import { categoryOf } from '@poe-upgrade-finder/vocab';
import type { GearSlot, PickedUnique } from '@poe-upgrade-finder/vocab';
import { UserFacingError } from '../ui/user-facing-error.ts';

/**
 * The picked unique in PoB's list for the item type, by name and base (several share a name: Doryani's Delusion
 * has three boots); a user-facing error when PoB has none.
 */
export function pickedUnique(data: UniquesData, picked: PickedUnique): UniqueInfo {
    const found: UniqueInfo | undefined = data.uniques.find((u: UniqueInfo) => u.name === picked.name && u.base === picked.base);
    if (found === undefined) {
        throw new UserFacingError(
            `PoB has no unique named ${picked.name} (${picked.base}) for ${data.itemType}. Pick it again in the list.`,
        );
    }
    return found;
}

/** One line per strip hard need the unique has no line for. The run still goes ahead. */
export function uniqueNotes(unique: UniqueInfo, requirements: readonly SearchRequirement[]): string[] {
    return uniqueNeedGaps(
        unique,
        requirements.filter((r: SearchRequirement) => r.origin === 'strip'),
    ).map(
        (r: SearchRequirement) =>
            `${unique.name} has no line for ${r.label}: only copies that get it from a corruption or an enchant can pass.`,
    );
}

/**
 * What a unique run uses in place of PoB's generator result: the slot's item (the header's "current item") and
 * the unique's category, with no weights and no PoB query. Nothing in it is PoB's weighting.
 */
export function uniqueRunQuery(slot: GearSlot, itemType: string, data: UniquesData, equipped: readonly EquippedItem[]): TradeQueryData {
    const inSlot: EquippedItem | undefined = equipped.find((e: EquippedItem) => e.slot === slot);
    const item: ItemInfo =
        inSlot === undefined
            ? { name: '', base: '', rarity: 'NONE', type: undefined }
            : { name: inSlot.name, base: inSlot.base, rarity: inSlot.rarity, type: inSlot.type };
    return {
        slot: slot,
        target: data.target,
        item: item,
        category: { query: categoryOf(itemType) ?? '', generator: itemType },
        statWeights: [],
        affixQuality: undefined,
        baseStatValue: 0,
        weights: [],
        query: { stats: [], raw: {} },
        queryError: undefined,
        calcs: 0,
        seconds: 0,
        log: [],
    };
}
