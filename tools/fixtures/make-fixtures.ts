// Turns local recordings into the static test fixtures in test/fixtures/ (private repo only; the publish
// allowlist leaves test/ out). Tests must never read the PoB Builds folder or app data: those change.
//
//   node tools/fixtures/make-fixtures.ts build <in.xml> <out.xml>
//       a PoB save with the account hash, character hash and share link taken off its <Import> line
//   node tools/fixtures/make-fixtures.ts trade <in-raw.json> <out.json> [--name <unique>]
//       a spike trade recording with every seller's account and character name replaced (seller1#0000,
//       Character1, ... consistently) and any whisper or hideout token dropped. A newer spike's `fetches`
//       list (V29) becomes the `fetch` list --replay reads; --name keeps only that unique's listings.
//   node tools/fixtures/make-fixtures.ts digest <in.json> <out.json> <league>...
//       a GGG Currency Exchange digest cut down to the named leagues' markets

import { readFileSync, writeFileSync } from 'node:fs';
import { isRecord } from '@poe-upgrade-finder/validate';

const IMPORT_ATTRS_DROPPED: readonly string[] = ['lastAccountHash', 'lastCharacterHash', 'importLink'];
const TOKEN_KEYS: readonly string[] = ['whisper_token', 'hideout_token', 'whisper'];

function build(xml: string): string {
    return xml.replace(/<Import\b[^>]*>/g, (tag: string) => {
        let out: string = tag;
        for (const attr of IMPORT_ATTRS_DROPPED) {
            out = out.replace(new RegExp(String.raw`\s${attr}="[^"]*"`, 'g'), '');
        }
        return out;
    });
}

class Renamer {
    private readonly accounts: Map<string, string> = new Map<string, string>();
    private readonly characters: Map<string, string> = new Map<string, string>();

    public account(name: string): string {
        return this.mapped(this.accounts, name, (n: number) => `seller${n}#0000`);
    }

    public character(name: string): string {
        return this.mapped(this.characters, name, (n: number) => `Character${n}`);
    }

    /** Every original name, longest first, for a last pass over all other strings. */
    public originals(): readonly [string, string][] {
        return [...this.accounts, ...this.characters].sort((a: [string, string], b: [string, string]) => b[0].length - a[0].length);
    }

    private mapped(map: Map<string, string>, name: string, make: (n: number) => string): string {
        const known: string | undefined = map.get(name);
        if (known !== undefined) {
            return known;
        }
        const fresh: string = make(map.size + 1);
        map.set(name, fresh);
        return fresh;
    }
}

function renameSellers(value: unknown, names: Renamer): unknown {
    if (Array.isArray(value)) {
        return value.map((v: unknown) => renameSellers(v, names));
    }
    if (!isRecord(value)) {
        return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
        if (TOKEN_KEYS.includes(key)) {
            continue;
        }
        if (key === 'account' && isRecord(v)) {
            const account: Record<string, unknown> = { ...v };
            if (typeof account['name'] === 'string') {
                account['name'] = names.account(account['name']);
            }
            if (typeof account['lastCharacterName'] === 'string') {
                account['lastCharacterName'] = names.character(account['lastCharacterName']);
            }
            out[key] = account;
        } else {
            out[key] = renameSellers(v, names);
        }
    }
    return out;
}

function replaceEverywhere(value: unknown, pairs: readonly [string, string][]): unknown {
    if (typeof value === 'string') {
        let s: string = value;
        for (const [from, to] of pairs) {
            s = s.split(from).join(to);
        }
        return s;
    }
    if (Array.isArray(value)) {
        return value.map((v: unknown) => replaceEverywhere(v, pairs));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]: [string, unknown]) => [k, replaceEverywhere(v, pairs)]));
    }
    return value;
}

/** The recording in the shape --replay reads (`fetch`), with only the named item's listings when one is given. */
function replayShape(raw: unknown, name: string | undefined): unknown {
    if (!isRecord(raw)) {
        throw new Error('not a trade recording');
    }
    const calls: unknown = raw['fetch'] ?? raw['fetches'];
    if (!Array.isArray(calls)) {
        throw new Error('the recording has no fetch list');
    }
    const keep = (entry: unknown): boolean => {
        if (name === undefined) {
            return true;
        }
        const item: unknown = isRecord(entry) ? entry['item'] : undefined;
        return isRecord(item) && item['name'] === name;
    };
    const fetch: unknown[] = [];
    for (const call of calls) {
        if (!isRecord(call) || !isRecord(call['json']) || !Array.isArray(call['json']['result'])) {
            continue;
        }
        const result: unknown[] = call['json']['result'].filter(keep);
        if (result.length === 0) {
            continue;
        }
        const ids: unknown[] = result.map((e: unknown) => (isRecord(e) ? e['id'] : undefined));
        fetch.push({ ...call, ids: ids, json: { ...call['json'], result: result } });
    }
    const { fetches: _fetches, ...rest } = raw;
    return { ...rest, fetch: fetch };
}

function trade(text: string, name: string | undefined): string {
    const names: Renamer = new Renamer();
    const renamed: unknown = renameSellers(replayShape(JSON.parse(text), name), names);
    // Names can also turn up in notes or labels: replace them wherever they are.
    const clean: unknown = replaceEverywhere(renamed, names.originals());
    const left: string = JSON.stringify(clean);
    for (const [from] of names.originals()) {
        if (left.includes(from)) {
            throw new Error(`a seller name is still in the output: ${from}`);
        }
    }
    return left;
}

function digest(text: string, leagues: readonly string[]): string {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !Array.isArray(parsed['markets'])) {
        throw new Error('not a currency exchange digest');
    }
    const markets: unknown[] = parsed['markets'].filter(
        (m: unknown) => isRecord(m) && typeof m['league'] === 'string' && leagues.includes(m['league']),
    );
    return JSON.stringify({ ...parsed, markets: markets });
}

function main(args: readonly string[]): number {
    const [kind, input, output, ...rest] = args;
    if (kind === undefined || input === undefined || output === undefined) {
        process.stderr.write('usage: make-fixtures.ts build|trade|digest <in> <out> [league... | --name <unique>]\n');
        return 2;
    }
    const text: string = readFileSync(input, 'utf8');
    if (kind === 'build') {
        writeFileSync(output, build(text));
    } else if (kind === 'trade') {
        const at: number = rest.indexOf('--name');
        writeFileSync(output, trade(text, at === -1 ? undefined : rest[at + 1]));
    } else if (kind === 'digest') {
        if (rest.length === 0) {
            throw new Error('name at least one league to keep');
        }
        writeFileSync(output, digest(text, rest));
    } else {
        process.stderr.write(`unknown kind: ${kind}\n`);
        return 2;
    }
    process.stdout.write(`wrote ${output}\n`);
    return 0;
}

process.exitCode = main(process.argv.slice(2));
