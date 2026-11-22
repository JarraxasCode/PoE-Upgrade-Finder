// ModCatalog (PLAN.md, Search spec, "What v1 must build"): names trade stats for people. v1 is backed by the
// trade site's stat list; v2 adds per-slot mod lists from PoB's data behind the same interface.

import type { TradeStatEntry } from '@poe-upgrade-finder/trade';
import type { SlotId } from './spec.ts';

export class ModCatalog {
    private readonly byId: ReadonlyMap<string, TradeStatEntry>;
    private readonly entries: readonly TradeStatEntry[];

    public constructor(entries: readonly TradeStatEntry[]) {
        this.entries = entries;
        this.byId = new Map<string, TradeStatEntry>(entries.map((e: TradeStatEntry) => [e.id, e]));
    }

    public get size(): number {
        return this.entries.length;
    }

    /** "+# to maximum Life", with the type when it isn't a plain explicit ("(pseudo) +# total maximum Life"); undefined when unknown. */
    public describe(statId: string): string | undefined {
        const e: TradeStatEntry | undefined = this.byId.get(statId);
        if (e === undefined) {
            return undefined;
        }
        return e.type === 'explicit' ? e.text : `(${e.type}) ${e.text}`;
    }

    /** v1: the whole list (the trade site's list isn't per slot). v2 narrows it with PoB's mod data. */
    public modsForSlot(_slot: SlotId): readonly TradeStatEntry[] {
        return this.entries;
    }
}
