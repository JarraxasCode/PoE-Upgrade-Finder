// The smoke check a PoB update must pass before it goes live (PLAN.md, "Updating PoB in the app", step 4):
// in its own worker on the staged copy, the user's loaded build loads, an equipped item re-listed in its own
// slot scores exactly +0, and PoB's trade query generator runs for that slot. Numbers may move between PoB
// versions (that's what an update is for), so the old and new baselines are reported, not compared. With or
// without a build, PoB's mod data for one item type must have every mod source (issue #66): a renamed PoB table
// must never quietly empty the slot plan editor.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
    EngineClient,
    luahostCommand,
    resolveEnginePaths,
    type LoadBuildData,
    type ScoreItemResult,
    type SlotData,
    type StatBlock,
    type WithWarnings,
} from '@poe-upgrade-finder/engine-client';
import type { Logger } from '@poe-upgrade-finder/logging';
import { SLOT_INFLUENCES, SLOT_SOURCES } from '@poe-upgrade-finder/vocab';
import type { GearSlot } from '@poe-upgrade-finder/vocab';

/** The item type whose slot data the smoke check reads: gloves roll from every mod source, and some bases have implicits. */
export const SMOKE_ITEM_TYPE: string = 'Gloves';

/**
 * What an item type's slot data lacks, as short phrases: a mod source with no mods, no base with an implicit,
 * no influence that adds a mod. Empty when nothing is missing. Meant for an item type that has them all
 * (SMOKE_ITEM_TYPE).
 */
export function slotDataGaps(data: SlotData): readonly string[] {
    const gaps: string[] = [];
    if (data.bases.length === 0) {
        gaps.push('no bases');
    }
    for (const source of SLOT_SOURCES) {
        if (!data.families.some((f) => f.source === source)) {
            gaps.push(`no ${source} mods`);
        }
    }
    if (!data.bases.some((b) => b.implicits.length > 0)) {
        gaps.push('no base with an implicit');
    }
    const influenced: boolean = data.bases.some((b) =>
        SLOT_INFLUENCES.some((i) => {
            const pool: number | undefined = i === 'none' ? undefined : b.pools[i];
            return pool !== undefined && (data.pools[pool]?.length ?? 0) > 0;
        }),
    );
    if (!influenced) {
        gaps.push('no influenced mods');
    }
    return gaps;
}

/** Throws unless PoB's mod data for SMOKE_ITEM_TYPE has every source (slotDataGaps). */
async function checkSlotData(client: EngineClient): Promise<void> {
    const data: WithWarnings<SlotData> = await client.slotData(SMOKE_ITEM_TYPE);
    const gaps: readonly string[] = slotDataGaps(data);
    if (gaps.length > 0) {
        throw new Error(`PoB's mod data for ${SMOKE_ITEM_TYPE} is incomplete (${gaps.join(', ')})`);
    }
}

const SLOTS: readonly GearSlot[] = [
    'Boots',
    'Gloves',
    'Helmet',
    'Body Armour',
    'Belt',
    'Amulet',
    'Ring 1',
    'Ring 2',
    'Weapon 2',
    'Weapon 1',
];

function isSlot(value: string): value is GearSlot {
    return (SLOTS as readonly string[]).includes(value);
}

function short(n: number): string {
    return Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
}

/** The values that differ between two stat blocks (numbers compared exactly). */
export function differingKeys(a: StatBlock, b: StatBlock): readonly string[] {
    const keys: Set<string> = new Set<string>([...Object.keys(a.values), ...Object.keys(b.values)]);
    const out: string[] = [];
    if (a.damage !== b.damage) {
        out.push('damage');
    }
    for (const key of keys) {
        if (a.values[key] !== b.values[key]) {
            out.push(key);
        }
    }
    return out;
}

/**
 * Throws with a reason when the staged copy fails; returns a one-line note when it passes. With no build
 * loaded, it only checks that PoB starts.
 */
export async function pobSmokeCheck(
    pobDir: string,
    build: { readonly file: string; readonly baseline: StatBlock } | undefined,
    logger: Logger,
): Promise<string> {
    const client: EngineClient = new EngineClient({ command: luahostCommand(resolveEnginePaths(pobDir)), logger: logger });
    try {
        if (build === undefined) {
            await client.ping();
            await checkSlotData(client);
            return `PoB starts and its mod data has all ${SLOT_SOURCES.length} sources (no build was loaded to try).`;
        }
        const xml: string = readFileSync(build.file, 'utf8').replace(/^﻿/, '');
        const load: WithWarnings<LoadBuildData> = await client.loadBuild(xml, basename(build.file));
        if (!Number.isFinite(load.baseline.damage)) {
            throw new Error('your build loads, but its damage reads as not a number');
        }
        const item = load.equipped.find((e) => isSlot(e.slot) && e.text !== '');
        let relisted: string = 'no equipped item to re-list';
        if (item !== undefined && isSlot(item.slot)) {
            const slot: GearSlot = item.slot;
            let result: ScoreItemResult | undefined;
            await client.score(slot, [item.text], (r: ScoreItemResult) => {
                result = r;
            });
            if (result === undefined || !result.ok) {
                throw new Error(`your ${slot} couldn't be scored on it`);
            }
            const diff: readonly string[] = differingKeys(result.stats, load.baseline);
            if (diff.length > 0) {
                throw new Error(`your own ${slot} re-listed doesn't score +0 (${diff.slice(0, 3).join(', ')} differ)`);
            }
            await client.tradeQuery(slot, {});
            relisted = `your ${slot} re-listed scores +0 and the trade search builds`;
        }
        await checkSlotData(client);
        return `Your build loads on it, ${relisted}, its mod data has all ${SLOT_SOURCES.length} sources; damage ${short(build.baseline.damage)} before, ${short(load.baseline.damage)} now.`;
    } finally {
        await client.shutdown().catch(() => undefined);
    }
}
