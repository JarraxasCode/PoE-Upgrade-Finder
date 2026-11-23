// The headless mode (PLAN.md, Phases, Phase 2): one real signed-in search for one slot, end to end, with
// no main window. Live finds and the summary go to the terminal; the run's JSON, the summary text and the
// raw trade responses (tokens stripped) go to the app data folder, with the JSON Lines log.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { session } from 'electron';
import { UsageError } from '@poe-upgrade-finder/cli/args';
import {
    bandSearches,
    compileQuery,
    DEFAULT_FLOORS,
    generatorWeights,
    priceBands,
    readFloorSettings,
    runSlotSearch,
    saveSpec,
    v1SpecBuilder,
} from '@poe-upgrade-finder/core';
import type { BandSearch, CompiledQuery, FloorSettings, PriceBand, RunEvent, RunResult, SlotSearchSpec } from '@poe-upgrade-finder/core';
import { EngineClient, luahostCommand, resolveEnginePaths } from '@poe-upgrade-finder/engine-client';
import type { LoadBuildData, StatsData, StripData, TradeQueryData, WithWarnings } from '@poe-upgrade-finder/engine-client';
import { JsonlLogger } from '@poe-upgrade-finder/logging';
import type { Logger } from '@poe-upgrade-finder/logging';
import { DivineRateClient, nodeFetchTransport, RateLimiter, stripTokens, TradeClient } from '@poe-upgrade-finder/trade';
import type { LimiterEvent, RateLookup, RecordedResponse, TradePolicy } from '@poe-upgrade-finder/trade';
import { electronTransport } from './electron-transport.ts';
import { parseHeadless, USAGE } from './options.ts';
import type { HeadlessOptions } from './options.ts';
import { CacheDb } from './services/cache-db.ts';
import { liveLine, summaryText } from './report.ts';
import { engineAdapter, pruneRuns, writeRunRecord } from './run/shared.ts';
import { openSignInWindow, probeSignIn, TRADE_PARTITION } from './signin.ts';
import type { SignInState } from './signin.ts';
import { stackOf } from '@poe-upgrade-finder/validate';

function say(text: string): void {
    process.stdout.write(`${text}\n`);
}

function stamp(ms: number): string {
    return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

interface Prepared {
    readonly engine: EngineClient;
    readonly build: LoadBuildData;
    readonly baseline: StatsData;
    readonly stripped: StripData;
    readonly query: TradeQueryData;
}

async function prepareEngine(opts: HeadlessOptions, xml: string, log: Logger): Promise<Prepared> {
    const engine: EngineClient = new EngineClient({ command: luahostCommand(resolveEnginePaths(opts.pob)), logger: log });
    await engine.start();
    const build: WithWarnings<LoadBuildData> = await engine.loadBuild(xml, basename(opts.build));
    const baseline: WithWarnings<StatsData> = await engine.stats({ target: opts.target });
    const stripped: WithWarnings<StripData> = await engine.strip(opts.slot, { target: opts.target });
    const query: WithWarnings<TradeQueryData> = await engine.tradeQuery(opts.slot, {
        target: opts.target,
        ...generatorWeights(opts.blend),
    });
    return { engine: engine, build: build, baseline: baseline, stripped: stripped, query: query };
}

export async function runHeadless(argv: readonly string[], userData: string, appVersion: string): Promise<number> {
    let opts: HeadlessOptions;
    try {
        opts = parseHeadless(argv);
    } catch (error: unknown) {
        if (error instanceof UsageError) {
            process.stderr.write(`${error.message}\n\n${USAGE}\n`);
            return 64;
        }
        throw error;
    }
    const started: number = Date.now();
    const runId: string = `${opts.slot.replace(/ /g, '')}-${stamp(started)}`;
    const logger: JsonlLogger = new JsonlLogger({ dir: join(userData, 'logs'), debug: opts.debug });
    logger.startRun(runId);
    const runLog: Logger = logger.area('run');
    const runsDir: string = join(userData, 'runs');
    mkdirSync(runsDir, { recursive: true });

    const floors: FloorSettings =
        opts.floorsFile === undefined ? DEFAULT_FLOORS : readFloorSettings(JSON.parse(readFileSync(opts.floorsFile, 'utf8')));
    const xml: string = readFileSync(opts.build, 'utf8').replace(/^﻿/, '');
    runLog.log('info', 'headless run starting', {
        runId: runId,
        slot: opts.slot,
        league: opts.league,
        budget: opts.budget,
        depth: opts.depth,
        blend: opts.blend,
        target: opts.target,
        listing: opts.listing,
        floors: floors,
        build: basename(opts.build),
    });
    say(
        `poe-upgrade-finder ${appVersion}: ${opts.slot} on ${basename(opts.build)}, ${opts.league}, ${opts.depth} (${opts.perBand} per band)`,
    );

    // PoB first, in the background: it takes a few seconds and needs no network.
    const enginePrep: Promise<Prepared> = prepareEngine(opts, xml, logger.area('engine'));
    enginePrep.catch(() => undefined); // awaited below; this only stops an early unhandled rejection

    const recorded: RecordedResponse[] = [];
    const limiter: RateLimiter<TradePolicy> = new RateLimiter<TradePolicy>({
        onEvent: (event: LimiterEvent<TradePolicy>): void => {
            const rateLog: Logger = logger.area('rate');
            if (event.kind === 'send') {
                rateLog.log('debug', `send ${event.key}`, { label: event.label });
            } else if (event.kind === 'wait') {
                rateLog.log('info', `wait ${Math.round(event.waitMs)}ms`, { key: event.key, reason: event.reason });
                if (event.waitMs >= 2000) {
                    say(`  rate limit: waiting ${(event.waitMs / 1000).toFixed(1)}s (${event.key}: ${event.reason})`);
                }
            } else if (event.kind === 'stop') {
                rateLog.log('warn', 'stop', { key: event.key, waitMs: event.waitMs, reason: event.reason });
            } else if (event.kind === 'retry-after') {
                rateLog.log('warn', `429, Retry-After ${event.seconds}s`, { key: event.key });
                say(`  rate limit: the site said wait ${event.seconds}s`);
            }
        },
    });
    const tradeSession = session.fromPartition(TRADE_PARTITION);
    // Electron's default user agent, unchanged (Hard rules); logged because Cloudflare reacts to it (V15).
    logger.area('signin').log('info', 'trade session', { partition: TRADE_PARTITION, userAgent: tradeSession.getUserAgent() });
    const client: TradeClient = new TradeClient({
        transport: electronTransport(tradeSession),
        limiter: limiter,
        logger: logger.area('trade'),
        ...(opts.record
            ? {
                  onResponse: (r: RecordedResponse): void => {
                      recorded.push({ ...r, json: stripTokens(r.json) });
                  },
              }
            : {}),
    });

    let prepared: Prepared | undefined;
    try {
        let state: SignInState = opts.dryRun ? 'signed-in' : await probeSignIn(client, opts.league);
        if (state !== 'signed-in') {
            say(
                state === 'cloudflare'
                    ? 'Cloudflare wants a check: a pathofexile.com window is opening.'
                    : 'Not signed in: a pathofexile.com sign-in window is opening.',
            );
            say('Sign in there (tick "Remember me"). The window closes by itself once you reach My Account.');
            say("If you don't see it, look for it on the taskbar (it flashes).");
            await openSignInWindow(logger.area('signin'));
            state = await probeSignIn(client, opts.league);
            if (state !== 'signed-in') {
                say('Still not signed in, so nothing was searched. Run it again to retry.');
                runLog.log('warn', 'stopped: not signed in', { state: state });
                return 2;
            }
        }
        say(opts.dryRun ? 'Dry run: no trade calls.' : 'Signed in to pathofexile.com.');

        const cache: CacheDb = new CacheDb(join(userData, 'cache.sqlite'));
        const rates: DivineRateClient = new DivineRateClient({
            transport: nodeFetchTransport,
            logger: logger.area('rate'),
            appVersion: appVersion,
            store: cache.rateStore(),
        });
        let chaosPerDivine: number | undefined = opts.rate;
        let rateText: string = opts.rate === undefined ? 'unknown' : `${opts.rate}c (typed in)`;
        if (opts.rate === undefined && !opts.dryRun) {
            const lookup: RateLookup = await rates.current(opts.league);
            chaosPerDivine = lookup.rate?.chaosPerDivine;
            if (lookup.rate !== undefined) {
                const hour: string =
                    lookup.rate.hour === undefined ? '' : `, hour of ${new Date(lookup.rate.hour * 1000).toISOString().slice(11, 16)} UTC`;
                rateText = `${lookup.rate.chaosPerDivine.toFixed(1)}c (${lookup.rate.source === 'ggg' ? 'GGG exchange' : 'typed in'}${hour})`;
            } else {
                say('No divine rate from GGG; pass --rate <chaos per divine> to include divine-priced listings.');
            }
        }
        say(`Divine rate: ${rateText}`);
        if (opts.budget.unit === 'divine' && chaosPerDivine === undefined) {
            say('A budget in divines needs a divine rate: pass --rate, or give the budget in chaos.');
            return 64;
        }
        const budgetChaos: number = opts.budget.unit === 'chaos' ? opts.budget.amount : opts.budget.amount * (chaosPerDivine ?? 0);
        const budgetText: string =
            opts.budget.unit === 'chaos' ? `${budgetChaos}c` : `${opts.budget.amount}d ≈ ${Math.round(budgetChaos)}c`;

        say('Waiting for PoB (load, strip, trade query)...');
        prepared = await enginePrep;
        const b = prepared.baseline.stats;
        if (!(b.damage > 0)) {
            say(
                "The damage target reads 0 (the saved main skill does no damage). Pick one with --target skill:G.A, as the CLI's info command lists.",
            );
            return 64;
        }
        say(
            `PoB ${prepared.build.pobVersion}: damage ${Math.round(b.damage).toLocaleString('en-GB')}, EHP ${Math.round(Number(b.values['TotalEHP'] ?? 0)).toLocaleString('en-GB')}, life ${b.values['Life'] ?? '?'}; current ${opts.slot}: ${prepared.query.item.name || prepared.query.item.base}`,
        );

        const bands: PriceBand[] = priceBands(budgetChaos);
        const spec: SlotSearchSpec = v1SpecBuilder().build({
            slot: opts.slot,
            listingType: opts.listing,
            priceBands: bands,
            characterLevel: prepared.build.info.level,
            baseline: b,
            stripped: prepared.stripped.stats,
            pobQuery: prepared.query,
            floors: floors,
        });
        say(
            `Search: ${spec.category}, ${spec.weights.length} weighted stats from PoB's generator, ${spec.requirements.length} hard needs${spec.requirements.length > 0 ? `: ${spec.requirements.map((r) => r.label.replace(/^Required: /, '').replace(/, from strip$/, '')).join(', ')}` : ''}`,
        );
        say(`Bands: ${bands.map((x: PriceBand) => x.label).join(' | ')}`);

        if (opts.dryRun) {
            const queries: CompiledQuery[] = bands.flatMap((band: PriceBand) =>
                bandSearches(band, chaosPerDivine).map((s: BandSearch) => compileQuery(spec, s)),
            );
            for (const q of queries) {
                say(
                    `  ${bands.find((x: PriceBand) => x.id === q.bandId)?.label ?? q.bandId}, ${q.option}: complexity ${q.complexity} (${q.weightsUsed} weighted + ${spec.requirements.length} required${q.dropped.length > 0 ? `, ${q.dropped.length} dropped` : ''})`,
                );
            }
            say('Weights (PoB order):');
            for (const w of spec.weights) {
                say(`  ${w.weight.toFixed(4).padStart(9)}  ${w.statId}`);
            }
            const file: string = join(runsDir, `${runId}-queries.json`);
            writeFileSync(file, JSON.stringify({ spec: saveSpec(spec), queries: queries }, null, 1));
            say(`Saved: ${file}`);
            return 0;
        }

        const minGain: number = opts.minGainPct;
        const result: RunResult = await runSlotSearch(
            {
                league: opts.league,
                spec: spec,
                baseline: b,
                blend: opts.blend,
                depth: opts.perBand,
                chaosPerDivine: chaosPerDivine,
                value: { minGainPct: minGain },
            },
            client,
            engineAdapter(prepared.engine, opts.slot, opts.target),
            (event: RunEvent): void => {
                if (event.kind === 'search') {
                    const s = event.record;
                    const band: string = bands.find((x: PriceBand) => x.id === s.bandId)?.label ?? s.bandId;
                    say(
                        `${band}, ${s.option}: ${s.error === undefined ? `${s.total ?? 0} listings, fetching ${s.fetchPlanned}` : `refused: ${s.error}`}`,
                    );
                    runLog.log('info', 'search', { ...s, body: undefined, idList: undefined });
                } else if (event.kind === 'item') {
                    const line: string | undefined = liveLine(event.item, minGain);
                    if (line !== undefined) {
                        say(line);
                    }
                    runLog.log('debug', 'scored', {
                        id: event.item.item.id,
                        gain: event.item.gain,
                        floorsPass: event.item.floorsPass,
                        price: event.item.item.price ?? null,
                    });
                } else if (event.kind === 'warning') {
                    say(`  warning: ${event.message}`);
                    runLog.log('warn', event.message);
                } else if (event.kind === 'item-failed') {
                    runLog.log('warn', 'item failed to score', { id: event.listingId, message: event.message });
                } else if (event.kind === 'band-done') {
                    runLog.log('info', 'band done', { band: event.band.id, fetched: event.fetched, scored: event.scored });
                } else if (event.kind === 'skipped') {
                    runLog.log('debug', 'skipped', { id: event.listingId, reason: event.reason });
                } else {
                    runLog.log('info', 'gone before fetch', { ids: event.listingIds.length });
                }
            },
        );

        const summary: string = summaryText({
            league: opts.league,
            slot: opts.slot,
            budgetText: budgetText,
            rateText: rateText,
            bands: bands,
            result: result,
            minGainPct: minGain,
            top: 15,
        });
        say('');
        process.stdout.write(summary);
        const finished: number = Date.now();
        const verdict = result.verdict;
        writeRunRecord(runsDir, {
            runId: runId,
            startedMs: started,
            finishedMs: finished,
            appVersion: appVersion,
            pobVersion: prepared.build.pobVersion,
            build: basename(opts.build),
            league: opts.league,
            options: { ...opts, build: basename(opts.build) },
            budgetChaos: budgetChaos,
            chaosPerDivine: chaosPerDivine,
            baseline: b,
            target: prepared.baseline.target,
            currentItem: prepared.query.item,
            spec: spec,
            result: result,
        });
        writeFileSync(join(runsDir, `${runId}.txt`), summary);
        if (opts.record) {
            writeFileSync(join(runsDir, `${runId}-raw.json`), JSON.stringify(recorded));
        }
        say(
            `\nSaved: ${join(runsDir, `${runId}.json`)} (and .txt${opts.record ? ', -raw.json' : ''}); log ${join(userData, 'logs', 'runs', `${runId}.jsonl`)}`,
        );
        pruneRuns(runsDir);
        runLog.log('info', 'headless run done', {
            seconds: (finished - started) / 1000,
            counts: result.counts,
            verdict: verdict.note,
            stoppedReason: result.stoppedReason ?? null,
        });
        return result.stoppedReason === undefined ? 0 : 3;
    } catch (error: unknown) {
        const message: string = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        say(`Failed: ${message}`);
        runLog.log('error', 'headless run failed', { error: message, stack: stackOf(error) });
        return 1;
    } finally {
        const engine: EngineClient | undefined =
            prepared?.engine ??
            (await enginePrep.then(
                (p: Prepared) => p.engine,
                () => undefined,
            ));
        await engine?.shutdown().catch(() => undefined);
        logger.endRun();
    }
}
