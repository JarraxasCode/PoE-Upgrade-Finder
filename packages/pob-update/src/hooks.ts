// The PoB hooks the engine relies on (engine/lua). A cheap text check on a new copy before anything runs it:
// a renamed function shows up here with its file named, rather than as a Lua error mid-run.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PobHook {
    readonly file: string;
    readonly needle: string;
}

export const POB_HOOKS: readonly PobHook[] = [
    { file: 'src/HeadlessWrapper.lua', needle: 'loadBuildFromXML' },
    { file: 'src/Classes/CalcsTab.lua', needle: 'GetMiscCalculator' },
    { file: 'src/Classes/ItemsTab.lua', needle: 'repSlotName' },
    { file: 'src/Classes/TradeQueryGenerator.lua', needle: 'StartQuery' },
    { file: 'src/Modules/Data.lua', needle: 'powerStatList' },
];

/** Returns a message per hook that's missing, or an empty list. */
export async function checkHooks(dir: string, hooks: readonly PobHook[] = POB_HOOKS): Promise<readonly string[]> {
    const missing: string[] = [];
    for (const hook of hooks) {
        let text: string;
        try {
            text = await readFile(join(dir, hook.file), 'utf8');
        } catch {
            missing.push(`${hook.file} is missing`);
            continue;
        }
        if (!text.includes(hook.needle)) {
            missing.push(`${hook.file} no longer has ${hook.needle}`);
        }
    }
    return missing;
}
