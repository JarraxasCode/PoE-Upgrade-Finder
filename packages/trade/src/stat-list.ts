// The trade site's stat list, GET /api/trade/data/stats: every searchable stat id with its text, grouped by
// type (pseudo, explicit, implicit, fractured, enchant, crafted, ...). ModCatalog (core) uses it to name stats.

import { array, optional, record, string } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';

export interface TradeStatEntry {
    /** e.g. "explicit.stat_3299347043". */
    readonly id: string;
    /** e.g. "+# to maximum Life". */
    readonly text: string;
    /** e.g. "explicit", "pseudo". */
    readonly type: string;
}

/** Reads the response; entries without an id or text are skipped, a wrong shape throws. */
export function readStatList(json: unknown): TradeStatEntry[] {
    const r: JsonRecord = record(json, 'stats');
    const groups = array(r['result'], 'stats.result', (v: unknown, p: string) => {
        const g: JsonRecord = record(v, p);
        return array(g['entries'], `${p}.entries`, (e: unknown, q: string) => {
            const entry: JsonRecord = record(e, q);
            return {
                id: optional(entry['id'], `${q}.id`, string),
                text: optional(entry['text'], `${q}.text`, string),
                type: optional(entry['type'], `${q}.type`, string),
            };
        });
    });
    const out: TradeStatEntry[] = [];
    for (const group of groups) {
        for (const e of group) {
            if (e.id !== undefined && e.text !== undefined) {
                out.push({ id: e.id, text: e.text, type: e.type ?? e.id.split('.')[0] ?? '' });
            }
        }
    }
    return out;
}
