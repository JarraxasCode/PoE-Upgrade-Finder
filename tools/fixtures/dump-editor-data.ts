// Dumps the slot plan editor's data (`slot.data`) for one item type from real PoB, as JSON, for looking at
// and for test fixtures: node tools/fixtures/dump-editor-data.ts <itemType> <slot> <out.json> [base]

import { writeFileSync } from 'node:fs';
import { EngineClient, luahostCommand, pinnedPobDir, POB_DIR_ENV, resolveEnginePaths } from '@poe-upgrade-finder/engine-client';
import type { GearSlot } from '@poe-upgrade-finder/ipc';
import { GEAR_SLOTS } from '@poe-upgrade-finder/ipc';
import { slotEditorData } from '../../apps/desktop/src/services/slot-data.ts';

const [itemType, slotArg, out, base] = process.argv.slice(2);
const slot: GearSlot | undefined = GEAR_SLOTS.find((s: GearSlot) => s === slotArg);
if (itemType === undefined || slot === undefined || out === undefined) {
    throw new Error('usage: dump-editor-data.ts <itemType> <slot> <out.json> [base]');
}
const pob: string | undefined = process.env[POB_DIR_ENV] ?? pinnedPobDir();
if (pob === undefined) {
    throw new Error(`no PoB copy: set ${POB_DIR_ENV}`);
}
const engine: EngineClient = new EngineClient({ command: luahostCommand(resolveEnginePaths(pob)) });
try {
    const data = await engine.slotData(itemType);
    writeFileSync(out, JSON.stringify(slotEditorData(data, slot, base ?? null), null, 1));
} finally {
    await engine.shutdown();
}
