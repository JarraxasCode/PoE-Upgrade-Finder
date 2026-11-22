// Options of the headless mode (pure, so they're unit-tested without Electron).

import { parseArgs } from 'node:util';
import { parseBlend, parseSlot, parseTarget, UsageError } from '@poe-upgrade-finder/cli/args';
import { DEFAULT_MIN_GAIN_PCT, DEPTH_PER_BAND } from '@poe-upgrade-finder/core';
import type { SearchDepth } from '@poe-upgrade-finder/core';
import type { GearSlot, TargetRequest } from '@poe-upgrade-finder/engine-client';
import type { ListingStatus } from '@poe-upgrade-finder/trade';

export const DEFAULT_LEAGUE: string = 'Covens';

export const USAGE: string = `usage (from the repo root):
  npm run search -- --build <save.xml> --slot <slot> --budget <300 | 300c | 1.5d> [options]
options:
  --league <name>          trade league (default ${DEFAULT_LEAGUE})
  --depth thorough|normal|quick   listings scored per band: 100 / 50 / 20 (default thorough)
  --listing instant|whisper       instant buyout only (default), or include whisper listings
  --blend <0..1>           DPS share of the gain (default 0.5)
  --target saved|full|skill:G.A[.P]   damage target (default: as saved)
  --rate <chaos per divine>        use this divine rate instead of GGG's
  --min-gain <percent>     minimum gain for an upgrade (default ${DEFAULT_MIN_GAIN_PCT})
  --floors <file.json>     floor settings for this build (default: PLAN's floors)
  --pob <PoB copy>         else POE_UF_POB_DIR
  --dry-run                no trade calls: build the spec and the queries, print them, stop
  --no-record              don't save the raw trade responses
  --log-debug              debug lines in the log (not --debug: Electron takes that as Node's old debugger switch and exits)`;

export type Budget = { readonly amount: number; readonly unit: 'chaos' | 'divine' };

export interface HeadlessOptions {
    readonly build: string;
    readonly slot: GearSlot;
    readonly budget: Budget;
    readonly league: string;
    readonly depth: SearchDepth;
    readonly perBand: number;
    readonly listing: ListingStatus;
    readonly blend: number;
    readonly target: TargetRequest;
    readonly rate: number | undefined;
    readonly minGainPct: number;
    readonly floorsFile: string | undefined;
    readonly pob: string | undefined;
    readonly record: boolean;
    readonly dryRun: boolean;
    readonly debug: boolean;
}

export function parseBudget(text: string | undefined): Budget {
    if (text === undefined) {
        throw new UsageError('--budget is required, e.g. 300, 300c or 1.5d');
    }
    const match: RegExpMatchArray | null = /^\s*(\d+(?:\.\d+)?)\s*(c|chaos|d|div|divine)?\s*$/i.exec(text);
    const amount: number = Number(match?.[1]);
    if (match === null || !(amount > 0)) {
        throw new UsageError(`bad --budget ${text}: a number of chaos (300 or 300c) or divines (1.5d)`);
    }
    const unit: string = (match[2] ?? 'c').toLowerCase();
    return { amount: amount, unit: unit.startsWith('d') ? 'divine' : 'chaos' };
}

function parseDepth(text: string | undefined): SearchDepth {
    const depth: string = (text ?? 'thorough').toLowerCase();
    if (depth === 'thorough' || depth === 'normal' || depth === 'quick') {
        return depth;
    }
    throw new UsageError(`bad --depth ${text}: thorough, normal or quick`);
}

function parseListing(text: string | undefined): ListingStatus {
    const t: string = (text ?? 'instant').toLowerCase();
    if (t === 'instant' || t === 'securable') {
        return 'securable';
    }
    if (t === 'whisper' || t === 'online') {
        return 'online';
    }
    throw new UsageError(`bad --listing ${text}: instant or whisper`);
}

function parsePositiveNumber(name: string, text: string | undefined): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const n: number = Number(text);
    if (!(n > 0) || !Number.isFinite(n)) {
        throw new UsageError(`bad --${name} ${text}: a number above 0`);
    }
    return n;
}

/** argv: the arguments after Electron's own (process.argv.slice(2)), with the "search" mode word among them (positional, ignored here). */
export function parseHeadless(argv: readonly string[]): HeadlessOptions {
    const { values } = parseArgs({
        args: [...argv],
        strict: false,
        options: {
            build: { type: 'string' },
            slot: { type: 'string' },
            budget: { type: 'string' },
            league: { type: 'string' },
            depth: { type: 'string' },
            listing: { type: 'string' },
            blend: { type: 'string' },
            target: { type: 'string' },
            rate: { type: 'string' },
            'min-gain': { type: 'string' },
            floors: { type: 'string' },
            pob: { type: 'string' },
            'no-record': { type: 'boolean' },
            'dry-run': { type: 'boolean' },
            'log-debug': { type: 'boolean' },
        },
    });
    const str = (key: string): string | undefined => {
        const v: unknown = values[key];
        return typeof v === 'string' ? v : undefined;
    };
    const build: string | undefined = str('build');
    if (build === undefined) {
        throw new UsageError('--build <save.xml> is required');
    }
    const depth: SearchDepth = parseDepth(str('depth'));
    return {
        build: build,
        slot: parseSlot(str('slot')),
        budget: parseBudget(str('budget')),
        league: str('league') ?? DEFAULT_LEAGUE,
        depth: depth,
        perBand: DEPTH_PER_BAND[depth],
        listing: parseListing(str('listing')),
        blend: parseBlend(str('blend')),
        target: parseTarget(str('target')),
        rate: parsePositiveNumber('rate', str('rate')),
        minGainPct: parsePositiveNumber('min-gain', str('min-gain')) ?? DEFAULT_MIN_GAIN_PCT,
        floorsFile: str('floors'),
        pob: str('pob'),
        record: values['no-record'] !== true,
        dryRun: values['dry-run'] === true,
        debug: values['log-debug'] === true,
    };
}
