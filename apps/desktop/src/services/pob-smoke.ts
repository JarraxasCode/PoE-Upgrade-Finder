// The smoke check a PoB update must pass before it goes live (PLAN.md, "Updating PoB in the app", step 4):
// in its own worker on the staged copy, the user's loaded build loads, an equipped item re-listed in its own
// slot scores exactly +0, and PoB's trade query generator runs for that slot. Numbers may move between PoB
// versions (that's what an update is for), so the old and new baselines are reported, not compared.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
    EngineClient,
    luahostCommand,
    resolveEnginePaths,
    type GearSlot,
    type LoadBuildData,
    type ScoreItemResult,
    type StatBlock,
    type WithWarnings,
} from '@poe-upgrade-finder/engine-client';
import type { Logger } from '@poe-upgrade-finder/logging';

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
            return 'PoB starts (no build was loaded to try).';
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
        return `Your build loads on it, ${relisted}; damage ${short(build.baseline.damage)} before, ${short(load.baseline.damage)} now.`;
    } finally {
        await client.shutdown().catch(() => undefined);
    }
}
