// Development (--record-trade <file>): saves every trade search and fetch response of the app's real runs, so a
// run on live listings can become a test fixture (issue #46; it replaces the old headless mode's recording).
// The file has the shape --replay and the golden run test read (the V19 recording's): { search: [...], fetch:
// [{ label, at, queryId, ids, status, json }] }. Per-listing whisper and hideout tokens are stripped as each
// response comes in. Sellers' names stay, so the file stays in app data or another local folder: turn it into
// a committed fixture with `node tools/fixtures/make-fixtures.ts trade <file> <out>`, which replaces them.

import { writeFileSync } from 'node:fs';
import type { Logger } from '@poe-upgrade-finder/logging';
import { stripTokens } from '@poe-upgrade-finder/trade';
import type { RecordedResponse } from '@poe-upgrade-finder/trade';
import { messageOf } from '@poe-upgrade-finder/validate';

export interface RecordedSearch {
    readonly at: string;
    readonly path: string;
    readonly status: number;
    readonly json: unknown;
}

export interface RecordedFetch {
    readonly label: string;
    readonly at: string;
    /** The search id the fetch names (`?query=`), or null. */
    readonly queryId: string | null;
    readonly ids: readonly string[];
    readonly status: number;
    readonly json: unknown;
}

/** The listing ids and search id of a fetch path, e.g. /api/trade/fetch/a,b?query=Xyz. */
export function fetchTarget(path: string): { readonly ids: readonly string[]; readonly queryId: string | null } | undefined {
    const m: RegExpExecArray | null = /^\/api\/trade\/fetch\/([^?]+)(?:\?query=([^&]+))?/.exec(path);
    if (m === null || m[1] === undefined) {
        return undefined;
    }
    return {
        ids: m[1].split(',').map((id: string) => decodeURIComponent(id)),
        queryId: m[2] === undefined ? null : decodeURIComponent(m[2]),
    };
}

export class TradeRecorder {
    private readonly file: string;
    private readonly log: Logger;
    private readonly searches: RecordedSearch[] = [];
    private readonly fetches: RecordedFetch[] = [];

    public constructor(file: string, log: Logger) {
        this.file = file;
        this.log = log;
    }

    /** One trade response (the trade client's onResponse). Searches and fetches are kept; the rest is ignored. */
    public record(response: RecordedResponse): void {
        const at: string = new Date().toISOString();
        const json: unknown = stripTokens(response.json);
        if (response.policy === 'search') {
            this.searches.push({ at: at, path: response.path, status: response.status, json: json });
        } else if (response.policy === 'fetch') {
            const target = fetchTarget(response.path);
            if (target === undefined) {
                this.log.log('warn', 'record-trade: a fetch path it could not read', { path: response.path });
                return;
            }
            this.fetches.push({ label: 'fetch', at: at, queryId: target.queryId, ids: target.ids, status: response.status, json: json });
        } else {
            return;
        }
        this.write();
    }

    /** The whole file again after each response, so a run stopped halfway still leaves a usable recording. */
    private write(): void {
        try {
            writeFileSync(this.file, JSON.stringify({ search: this.searches, fetch: this.fetches }));
        } catch (error: unknown) {
            this.log.log('error', 'record-trade: could not write the recording', { file: this.file, error: messageOf(error) });
        }
    }
}
