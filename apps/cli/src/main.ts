// poe-upgrade-finder CLI (Phase 1): runs the engine on a saved build and fixture listings, no network.
//
//   node apps/cli/src/main.ts info  --build <save.xml>
//   node apps/cli/src/main.ts query --build <save.xml> --slot Boots [--blend 0.5] [--target ...] [--out q.json]
//   node apps/cli/src/main.ts score --build <save.xml> --slot Boots <listings...> [--blend 0.5] [--target ...]
//                                   [--all-rarities] [--top 20] [--out results.json]
// Common: --pob <PoB copy> (else POE_UF_POB_DIR), --verbose (engine log on stderr).
// Listings are ##ITEM dumps or recorded trade fetch JSON (see listings.ts).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EngineClient, EngineError, luahostCommand, resolveEnginePaths } from '@poe-upgrade-finder/engine-client';
import type {
    EngineLogger, GearSlot, LoadBuildData, LogLevel, ScoreItemResult, ScoreSummary, StatBlock, TargetRequest, TradeQueryData, WithWarnings,
} from '@poe-upgrade-finder/engine-client';
import { gainOf, generatorWeights } from '@poe-upgrade-finder/core';
import type { Gain } from '@poe-upgrade-finder/core';
import { parseBlend, parsePositive, parseSlot, parseTarget, UsageError } from './args.ts';
import { dedupe, readListingsFile } from './listings.ts';
import type { Listing } from './listings.ts';
import { formatPrice, pct, signed, table } from './format.ts';

const USAGE: string = `usage:
  info  --build <save.xml>
  query --build <save.xml> --slot <slot> [--blend 0.5] [--target saved|full|skill:G.A[.P]] [--out file.json]
  score --build <save.xml> --slot <slot> <listings...> [--blend 0.5] [--target ...] [--all-rarities] [--top 20] [--out file.json]
common: --pob <PoB copy folder> (else POE_UF_POB_DIR), --verbose`;

interface Options {
    readonly build: string | undefined;
    readonly slot: string | undefined;
    readonly target: string | undefined;
    readonly blend: string | undefined;
    readonly pob: string | undefined;
    readonly out: string | undefined;
    readonly top: string | undefined;
    readonly allRarities: boolean;
    readonly verbose: boolean;
}

function stderrLogger(verbose: boolean): EngineLogger {
    const shown: ReadonlySet<LogLevel> = new Set<LogLevel>(verbose ? ['debug', 'info', 'warn', 'error'] : ['warn', 'error']);
    return {
        log(level: LogLevel, message: string, data?: Readonly<Record<string, unknown>>): void {
            if (!shown.has(level) || (!verbose && data?.['area'] === 'pob')) {
                return;
            }
            const extra: string = data && !verbose && level === 'warn' && 'text' in data ? '' : data ? ` ${JSON.stringify(data)}` : '';
            process.stderr.write(`[${level}] ${message}${extra}\n`);
        },
    };
}

/** A progress line that rewrites itself, shown only on a terminal. */
function progress(text: string): void {
    if (process.stderr.isTTY) {
        process.stderr.write(`\r  ${text}`);
    }
}

function progressDone(): void {
    if (process.stderr.isTTY) {
        process.stderr.write('\n');
    }
}

function readBuild(path: string | undefined): string {
    if (path === undefined) {
        throw new UsageError('--build <save.xml> is required');
    }
    if (!existsSync(path)) {
        throw new UsageError(`no build file at ${path}`);
    }
    return readFileSync(path, 'utf8').replace(/^﻿/, '');
}

function printWarnings(warnings: readonly { readonly code: string; readonly message: string }[]): void {
    for (const w of warnings) {
        process.stdout.write(`warning (${w.code}): ${w.message}\n`);
    }
}

function describeTarget(build: LoadBuildData, target: TargetRequest | LoadBuildData['target']): string {
    if (target.kind === 'fullDps') {
        return 'Full DPS';
    }
    if (target.kind === 'saved') {
        return describeTarget(build, build.target);
    }
    const group = build.skills.find((g) => g.index === target.group);
    const skill = group?.activeSkills.find((a) => a.index === target.activeSkill);
    const part: string = target.part !== undefined && skill ? ` (${skill.parts[target.part - 1] ?? `part ${target.part}`})` : '';
    return `${skill?.name ?? '?'}${part} [skill:${target.group}.${target.activeSkill}${target.part !== undefined ? `.${target.part}` : ''}]`;
}

function value(stats: StatBlock, key: string): string {
    const v: number | boolean | undefined = stats.values[key];
    if (v === undefined) {
        return '-';
    }
    if (typeof v === 'boolean') {
        return String(v);
    }
    return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(v);
}

async function info(engine: EngineClient, build: WithWarnings<LoadBuildData>): Promise<void> {
    const b: StatBlock = build.baseline;
    const i = build.info;
    process.stdout.write(`${i.className ?? '?'} / ${i.ascendClassName ?? '?'}, level ${i.level ?? '?'}, tree ${i.treeVersion ?? '?'}, PoB ${build.pobVersion}\n`);
    process.stdout.write(`target as saved: ${describeTarget(build, build.target)} = ${Math.round(b.damage)}\n`);
    process.stdout.write(`EHP ${value(b, 'TotalEHP')}, Life ${value(b, 'Life')}, ES ${value(b, 'EnergyShield')}, res F/C/L/Ch ${value(b, 'FireResist')}/${value(b, 'ColdResist')}/${value(b, 'LightningResist')}/${value(b, 'ChaosResist')}\n`);
    printWarnings(build.warnings);
    process.stdout.write('\nskills (for --target skill:G.A[.P]):\n');
    const rows: string[][] = [];
    for (const g of build.skills) {
        for (const a of g.activeSkills) {
            const parts: readonly string[] = a.parts.length > 0 ? a.parts : [''];
            for (let p: number = 0; p < parts.length; p++) {
                const target: TargetRequest = a.parts.length > 0 ? { kind: 'skill', group: g.index, activeSkill: a.index, part: p + 1 } : { kind: 'skill', group: g.index, activeSkill: a.index };
                const r = await engine.stats({ target: target });
                rows.push([
                    `skill:${g.index}.${a.index}${a.parts.length > 0 ? `.${p + 1}` : ''}`,
                    `${a.name}${parts[p] ? ` (${parts[p]})` : ''}${a.minion ? ` [${a.minion}]` : ''}`,
                    g.enabled ? (g.includeInFullDPS ? 'Full DPS' : '') : 'disabled',
                    String(Math.round(r.stats.damage)),
                ]);
            }
        }
    }
    process.stdout.write(table(['target', 'skill', 'group', 'DPS'], rows, [false, false, false, true]));
    process.stdout.write('\nequipped:\n');
    process.stdout.write(table(['slot', 'item', 'rarity'], build.equipped.map((e) => [e.slot, `${e.name}`, e.rarity]), [false, false, false]));
}

async function query(engine: EngineClient, slot: GearSlot, target: TargetRequest, blend: number, out: string | undefined): Promise<void> {
    const started: number = Date.now();
    const result: WithWarnings<TradeQueryData> = await engine.tradeQuery(slot, {
        target: target,
        ...generatorWeights(blend),
        onProgress: (p) => {
            progress(`generator: ${p.calcs} calcs, ${p.seconds.toFixed(1)} s`);
        },
    });
    progressDone();
    printWarnings(result.warnings);
    const weighted = result.query.stats[0]?.filters ?? [];
    process.stdout.write(`${slot}: ${result.item.name} (${result.category.query}); ${result.weights.length} weights kept, ${weighted.length} in PoB's query; ${result.calcs} calcs in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
    process.stdout.write(`weights: ${result.statWeights.map((w) => `${w.stat} ${w.weight}`).join(', ')}\n\n`);
    process.stdout.write(table(['#', 'trade stat', 'weight', 'gain per mod'], result.weights.map((w, i) => [String(i + 1), `${w.id}${w.invert ? ' (inverted)' : ''}`, w.weight.toFixed(4), w.meanStatDiff.toFixed(2)]), [true, false, true, true]));
    if (out) {
        writeFileSync(out, JSON.stringify(result, null, 2));
        process.stdout.write(`\nwrote ${out}\n`);
    }
}

interface ScoredRow {
    readonly listing: Listing;
    readonly result: ScoreItemResult;
    readonly gain: Gain | undefined;
}

async function score(engine: EngineClient, build: LoadBuildData, slot: GearSlot, target: TargetRequest, blend: number, files: readonly string[], options: Options): Promise<void> {
    if (files.length === 0) {
        throw new UsageError('score needs at least one listings file');
    }
    for (const f of files) {
        if (!existsSync(f)) {
            throw new UsageError(`no listings file at ${f}`);
        }
    }
    const all: Listing[] = dedupe(files.flatMap((f: string) => readListingsFile(f)));
    const listings: Listing[] = options.allRarities ? all : all.filter((l: Listing) => l.rarity === 'Rare');
    process.stdout.write(`${all.length} listings in ${files.length} file(s); scoring ${listings.length}${options.allRarities ? '' : ' rares'} in ${slot}, target ${describeTarget(build, target)}, blend ${blend}\n`);
    const before = await engine.stats({ target: target });
    const rows: ScoredRow[] = [];
    let done: number = 0;
    const summary: ScoreSummary = await engine.score(slot, listings.map((l: Listing) => l.text), (result: ScoreItemResult) => {
        const listing: Listing | undefined = listings[result.index];
        if (!listing) {
            return;
        }
        rows.push({ listing: listing, result: result, gain: result.ok ? gainOf(before.stats, result.stats, blend) : undefined });
        done++;
        if (done % 25 === 0 || done === listings.length) {
            progress(`scored ${done}/${listings.length}`);
        }
    }, { target: target });
    progressDone();
    const rank = (r: ScoredRow): number => (r.gain && !Number.isNaN(r.gain.gain) ? r.gain.gain : Number.NEGATIVE_INFINITY);
    const ok: ScoredRow[] = rows.filter((r: ScoredRow) => r.result.ok).sort((a: ScoredRow, b: ScoredRow) => rank(b) - rank(a));
    const top: number = parsePositive('top', options.top, 20);
    const lifeBefore: number | boolean | undefined = before.stats.values['Life'];
    process.stdout.write(table(['#', 'gain%', 'DPS%', 'EHP%', 'Life', 'price', 'item', 'notes'], ok.slice(0, top).map((r: ScoredRow, i: number) => {
        const res: ScoreItemResult = r.result;
        const notes: string[] = [];
        let life: string = '';
        if (res.ok) {
            if (res.unparsed.length > 0) {
                notes.push(`${res.unparsed.length} unparsed`);
            }
            if (!res.validForSlot) {
                notes.push('not for this slot');
            }
            const after: number | boolean | undefined = res.stats.values['Life'];
            life = typeof after === 'number' && typeof lifeBefore === 'number' ? signed(after - lifeBefore, 0) : '';
        }
        return [String(i + 1), pct(r.gain?.gain), pct(r.gain?.dpsPct), pct(r.gain?.ehpPct), life, formatPrice(r.listing.price), r.listing.label, notes.join(', ')];
    }), [true, true, true, true, true, true, false, false]));
    const failed: ScoredRow[] = rows.filter((r: ScoredRow) => !r.result.ok);
    for (const r of failed) {
        if (!r.result.ok) {
            process.stdout.write(`failed: ${r.listing.label} (${r.listing.id}): ${r.result.error.code}: ${r.result.error.message}\n`);
        }
    }
    process.stdout.write(`\n${summary.scored} scored, ${summary.failed} failed, ${summary.restarts} engine restarts, ${summary.seconds.toFixed(1)} s (${listings.length > 0 ? ((summary.seconds * 1000) / listings.length).toFixed(1) : '0'} ms per item)\n`);
    if (options.out) {
        writeFileSync(options.out, JSON.stringify({
            slot: slot, target: before.target, blend: blend, baseline: before.stats, summary: summary,
            results: rows.map((r: ScoredRow) => ({ id: r.listing.id, label: r.listing.label, price: r.listing.price, source: r.listing.source, gain: r.gain, result: r.result })),
        }, (_key: string, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 2));
        process.stdout.write(`wrote ${options.out}\n`);
    }
}

async function main(argv: readonly string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: {
            build: { type: 'string' }, slot: { type: 'string' }, target: { type: 'string' }, blend: { type: 'string' },
            pob: { type: 'string' }, out: { type: 'string' }, top: { type: 'string' },
            'all-rarities': { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
        },
    });
    const [command, ...files] = positionals;
    if (values.help || command === undefined) {
        process.stdout.write(`${USAGE}\n`);
        return command === undefined && !values.help ? 64 : 0;
    }
    const options: Options = {
        build: values.build, slot: values.slot, target: values.target, blend: values.blend, pob: values.pob, out: values.out,
        top: values.top, allRarities: values['all-rarities'], verbose: values.verbose,
    };
    if (command !== 'info' && command !== 'query' && command !== 'score') {
        throw new UsageError(`unknown command ${command}\n${USAGE}`);
    }
    const target: TargetRequest = parseTarget(options.target);
    const blend: number = parseBlend(options.blend);
    const slot: GearSlot | undefined = command === 'info' ? undefined : parseSlot(options.slot);
    const xml: string = readBuild(options.build);
    const engine: EngineClient = new EngineClient({ command: luahostCommand(resolveEnginePaths(options.pob)), logger: stderrLogger(options.verbose) });
    try {
        const build: WithWarnings<LoadBuildData> = await engine.loadBuild(xml, options.build);
        if (command === 'info') {
            await info(engine, build);
        } else if (slot !== undefined) {
            printWarnings(build.warnings);
            if (command === 'query') {
                await query(engine, slot, target, blend, options.out);
            } else {
                await score(engine, build, slot, target, blend, files, options);
            }
        }
        return 0;
    } finally {
        await engine.shutdown();
    }
}

main(process.argv.slice(2)).then((code: number) => {
    process.exitCode = code;
}, (error: unknown) => {
    if (error instanceof UsageError) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 64;
    } else if (error instanceof EngineError) {
        process.stderr.write(`engine error (${error.code}): ${error.message}\n`);
        process.exitCode = 2;
    } else {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    }
});
