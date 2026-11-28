// One single-slot run, from the spec to the verdict (PLAN.md, How it works, steps 5 to 7). The pipeline is
// fixed; only the spec changes:
//   per band, cheapest first: compile + search each currency → split the depth → fetch 10 at a time (the
//   band's searches interleaved, best first; ids already fetched for an earlier band are skipped) → PoB
//   scores each batch as it arrives → checks, notes, gain → stream the item.
//   Then: junk filter → value rule.
// "Search deeper" (deepenSlotSearch) reuses a finished run's searches: a bigger depth is split over the same
// id lists, only ids not fetched yet are fetched and scored, then the filter and verdict run over old and new.
//
// Trade and engine access are injected. A refused search (e.g. too complex) is recorded and the run goes
// on; a stop (rate-limit stop, cancel, lost session, Cloudflare) ends the run with what it has.

import { CancelledError, RateLimitStop, TradeError } from '@poe-upgrade-finder/trade';
import type { FetchResponse, SearchResponse, TradeListing, TradeSearchBody } from '@poe-upgrade-finder/trade';
import { bandSearches, budgetOf, chaosEquivalent, priceRole, splitDepth } from './bands.ts';
import type { BandSearch, PriceBand } from './bands.ts';
import { evaluateItem } from './evaluate.ts';
import type { EvaluatedItem } from './evaluate.ts';
import { junkFilter } from './junk.ts';
import type { FilteredItem } from './junk.ts';
import { compileQuery, QueryCompileError } from './query-compiler.ts';
import type { CompiledQuery } from './query-compiler.ts';
import { excludedModOf } from './excluded-mods.ts';
import type { ListedItem, SearchModExclusion, SlotSearchSpec } from './spec.ts';
import type { PobStats } from './stats.ts';
import { valuePick } from './value-rule.ts';
import type { ValueSettings, Verdict } from './value-rule.ts';
import { messageOf } from '@poe-upgrade-finder/validate';
import { excludedModText } from '@poe-upgrade-finder/vocab';
import type { ExcludedModCount, SkipReason } from '@poe-upgrade-finder/vocab';

export interface RunTrade {
    search(league: string, body: TradeSearchBody, signal?: AbortSignal): Promise<SearchResponse>;
    fetch(ids: readonly string[], queryId?: string, signal?: AbortSignal): Promise<FetchResponse>;
}

export type EngineScore =
    | {
          readonly index: number;
          readonly ok: true;
          readonly stats: PobStats;
          readonly unparsed: readonly string[];
          readonly validForSlot: boolean;
          /** Scored into Weapon 1 with Weapon 2 emptied: it can't be held beside the saved off-hand (#39, #101). */
          readonly offHandRemoved: boolean;
      }
    | { readonly index: number; readonly ok: false; readonly message: string };

export interface RunEngine {
    /** Scores item texts in the run's slot, one callback per item in order. */
    score(texts: readonly string[], onItem: (result: EngineScore) => void, signal?: AbortSignal): Promise<void>;
}

export interface SlotRunInput {
    readonly league: string;
    readonly spec: SlotSearchSpec;
    /** The build with the current item, with the run's damage target. */
    readonly baseline: PobStats;
    readonly blend: number;
    /** Listings scored per band. */
    readonly depth: number;
    readonly chaosPerDivine: number | undefined;
    readonly value?: ValueSettings;
    readonly signal?: AbortSignal;
    /** What the saved Weapon 2 holds, for the warning when results were scored without it (offHandName). */
    readonly offHand?: string;
    /** What PoB measures the slot against, for the warning when most of a band isn't for the slot: "beside a Wand". */
    readonly besides?: string;
    /** What narrowed the search, for the verdict when no listing in budget matched (#34). */
    readonly emptyCauses?: readonly string[];
}

/** How the off-hand warning names the saved Weapon 2, from its PoB item type ("Shield", "Quiver", "Wand"). */
export function offHandName(itemType: string | undefined): string {
    if (itemType === 'Shield') {
        return 'shield';
    }
    if (itemType === 'Quiver') {
        return 'quiver';
    }
    return itemType === undefined ? 'off-hand' : 'off-hand weapon';
}

/** The feed warning when some results were scored with Weapon 2 emptied (wording: Jarraxas, #39). */
export function offHandWarning(offHand: string): string {
    return (
        `Some results are two-handed or can't be held beside your ${offHand}: they were scored without it, so their gain ` +
        'includes losing it. Results may look odd next to one-handers.'
    );
}

export interface SearchRecord {
    readonly bandId: string;
    readonly option: BandSearch['option'];
    readonly body: TradeSearchBody;
    readonly predictedComplexity: number;
    readonly weightsUsed: number;
    readonly droppedWeights: number;
    readonly searchId: string | undefined;
    readonly total: number | undefined;
    readonly ids: number;
    /** The ids the search returned, best first (what "Search deeper" fetches further into). Not logged. */
    readonly idList: readonly string[];
    readonly siteComplexity: number | undefined;
    readonly fetchPlanned: number;
    readonly error: string | undefined;
}

export type { SkipReason };

export type RunEvent =
    | { readonly kind: 'search'; readonly record: SearchRecord }
    | { readonly kind: 'warning'; readonly message: string }
    /** Worth a line in the feed, not a warning: "1c to 5c: 2 listings dropped for an excluded mod (...)". */
    | { readonly kind: 'note'; readonly message: string }
    | { readonly kind: 'item'; readonly item: EvaluatedItem }
    | { readonly kind: 'item-failed'; readonly listingId: string; readonly message: string }
    | { readonly kind: 'skipped'; readonly listingId: string; readonly reason: SkipReason }
    | { readonly kind: 'missing'; readonly listingIds: readonly string[] }
    | { readonly kind: 'band-done'; readonly band: PriceBand; readonly fetched: number; readonly scored: number };

export interface RunCounts {
    readonly searches: number;
    readonly fetched: number;
    readonly scored: number;
    readonly failed: number;
    readonly skipped: number;
    /** The skipped listings by reason (they add up to skipped). */
    readonly skippedBy: Readonly<Record<SkipReason, number>>;
    /** The listings dropped for an excluded hybrid mod, per mod (#38); they add up to skippedBy['excluded-mod']. */
    readonly excludedMods: readonly ExcludedModCount[];
    readonly missing: number;
}

function noSkips(): Record<SkipReason, number> {
    return { 'not-for-slot': 0, unidentified: 0, 'already-fetched': 0, malformed: 0, 'excluded-mod': 0 };
}

/** Most listings of a band (over this share of those fetched) not for the slot: worth a warning (#39). */
const NOT_FOR_SLOT_WARN_SHARE: number = 0.5;

export interface RunResult {
    readonly searches: readonly SearchRecord[];
    readonly items: readonly FilteredItem[];
    /** Every listing id fetched (or tried), so a deeper pass never fetches one twice. */
    readonly fetchedIds: readonly string[];
    readonly verdict: Verdict;
    readonly counts: RunCounts;
    /** Set when the run stopped early (rate-limit stop, cancel, session, Cloudflare, engine failure). */
    readonly stoppedReason: string | undefined;
}

/** What a deeper pass carries over from the run it extends (a RunResult fits). */
export interface PriorRun {
    readonly searches: readonly SearchRecord[];
    readonly items: readonly FilteredItem[];
    readonly fetchedIds: readonly string[];
    readonly counts: RunCounts;
}

const FETCH_BATCH: number = 10;

interface PlannedSearch {
    readonly search: BandSearch;
    readonly compiled: CompiledQuery;
    readonly response: SearchResponse | undefined;
    readonly error: string | undefined;
}

/** Thrown inside the run to end it early with a reason. */
class StopRun extends Error {
    public override readonly name: string = 'StopRun';
}

function stopReason(error: unknown): string | undefined {
    if (error instanceof RateLimitStop) {
        return error.message;
    }
    if (error instanceof CancelledError) {
        return 'Cancelled.';
    }
    if (
        error instanceof TradeError &&
        (error.code === 'signed-out' || error.code === 'cloudflare' || error.code === 'redirect' || error.code === 'rate-limited')
    ) {
        return error.message;
    }
    return undefined;
}

/**
 * Interleaves the searches' ids, best first, taking `counts[i]` new ids from search i. An id `repeat` says an
 * earlier band already fetched is passed through (so it can be noted) without using up the count: the band
 * tops up past it to its full share (#111). Each id comes out once.
 */
export function interleave(
    lists: readonly (readonly string[])[],
    counts: readonly number[],
    repeat: (id: string) => boolean = () => false,
): string[] {
    const out: string[] = [];
    const seen: Set<string> = new Set<string>();
    const next: number[] = lists.map(() => 0);
    const used: number[] = lists.map(() => 0);
    let progress: boolean = true;
    while (progress) {
        progress = false;
        lists.forEach((list: readonly string[], i: number) => {
            // One new id per search per round; repeats on the way are passed through.
            while ((used[i] ?? 0) < (counts[i] ?? 0)) {
                const n: number = next[i] ?? 0;
                const id: string | undefined = list[n];
                if (id === undefined) {
                    return;
                }
                next[i] = n + 1;
                progress = true;
                const isRepeat: boolean = seen.has(id) || repeat(id);
                if (!seen.has(id)) {
                    seen.add(id);
                    out.push(id);
                }
                if (!isRepeat) {
                    used[i] = (used[i] ?? 0) + 1;
                    return;
                }
            }
        });
    }
    return out;
}

/** The shared state and steps of a run or a deeper pass. */
class Runner {
    public readonly records: SearchRecord[];
    private readonly evaluated: EvaluatedItem[];
    private readonly fetchedIds: Set<string>;
    private fetched: number;
    private scored: number;
    private failed: number;
    private skipped: number;
    private readonly skippedBy: Record<SkipReason, number>;
    /** Listings dropped per excluded mod name, in the order first dropped. */
    private readonly excludedMods: Map<string, number>;
    private missing: number;
    private stoppedReason: string | undefined;
    private warnedDropped: boolean = false;
    private warnedOffHand: boolean = false;
    private readonly input: SlotRunInput;
    private readonly trade: RunTrade;
    private readonly engine: RunEngine;
    private readonly onEvent: (event: RunEvent) => void;

    public constructor(input: SlotRunInput, trade: RunTrade, engine: RunEngine, onEvent: (event: RunEvent) => void, prior?: PriorRun) {
        this.input = input;
        this.trade = trade;
        this.engine = engine;
        this.onEvent = onEvent;
        this.records = [...(prior?.searches ?? [])];
        this.evaluated = (prior?.items ?? []).map((f: FilteredItem) => f.evaluated);
        this.fetchedIds = new Set<string>(prior?.fetchedIds ?? []);
        const before: RunCounts = prior?.counts ?? {
            searches: 0,
            fetched: 0,
            scored: 0,
            failed: 0,
            skipped: 0,
            skippedBy: noSkips(),
            excludedMods: [],
            missing: 0,
        };
        this.skippedBy = { ...before.skippedBy };
        this.excludedMods = new Map<string, number>(before.excludedMods.map((c: ExcludedModCount) => [c.name, c.dropped]));
        this.fetched = before.fetched;
        this.scored = before.scored;
        this.failed = before.failed;
        this.skipped = before.skipped;
        this.missing = before.missing;
    }

    /** Counts a skipped listing; with an id, the event goes out too. */
    private skip(reason: SkipReason, listingId: string | null): void {
        this.skipped++;
        this.skippedBy[reason]++;
        if (listingId !== null) {
            this.onEvent({ kind: 'skipped', listingId: listingId, reason: reason });
        }
    }

    /**
     * Whether an id was fetched for a band before this one: an earlier band's search returned it and it was
     * fetched. A deeper pass's own earlier fetches for this band aren't repeats: they still count to its depth.
     */
    public repeatFor(band: PriceBand): (id: string) => boolean {
        const order: readonly string[] = this.input.spec.priceBands.map((b: PriceBand) => b.id);
        const earlier: ReadonlySet<string> = new Set<string>(order.slice(0, Math.max(0, order.indexOf(band.id))));
        const returned: ReadonlySet<string> = new Set<string>(
            this.records.filter((r: SearchRecord) => earlier.has(r.bandId)).flatMap((r: SearchRecord) => r.idList),
        );
        return (id: string): boolean => returned.has(id) && this.fetchedIds.has(id);
    }

    public checkCancelled(): void {
        if (this.input.signal?.aborted === true) {
            throw new StopRun('Cancelled.');
        }
    }

    public async searchBand(band: PriceBand): Promise<PlannedSearch[]> {
        const planned: PlannedSearch[] = [];
        for (const search of bandSearches(band, this.input.chaosPerDivine)) {
            let compiled: CompiledQuery;
            try {
                compiled = compileQuery(this.input.spec, search);
            } catch (error: unknown) {
                if (error instanceof QueryCompileError) {
                    throw new StopRun(error.message);
                }
                throw error;
            }
            if (compiled.dropped.length > 0 && !this.warnedDropped) {
                this.warnedDropped = true;
                this.onEvent({
                    kind: 'warning',
                    message: `${compiled.dropped.length} low-priority weights left out to fit the site's complexity limit.`,
                });
            }
            let response: SearchResponse | undefined;
            let error: string | undefined;
            try {
                response = await this.trade.search(this.input.league, compiled.body, this.input.signal);
            } catch (e: unknown) {
                const reason: string | undefined = stopReason(e);
                if (reason !== undefined) {
                    throw new StopRun(reason);
                }
                if (!(e instanceof TradeError)) {
                    throw e;
                }
                error = e.message;
                this.onEvent({ kind: 'warning', message: `${band.label} (${search.option}) search failed: ${e.message}` });
            }
            planned.push({ search: search, compiled: compiled, response: response, error: error });
        }
        return planned;
    }

    /** Fetches the ids not fetched before (noting the repeats when asked), scores them, emits band-done. */
    public async fetchAndScore(band: PriceBand, ordered: readonly string[], noteRepeats: boolean): Promise<void> {
        const ids: string[] = [];
        const planned: Set<string> = new Set<string>();
        for (const id of ordered) {
            if (this.fetchedIds.has(id)) {
                if (noteRepeats) {
                    this.skip('already-fetched', id);
                }
            } else if (!planned.has(id)) {
                planned.add(id);
                ids.push(id);
            }
        }
        let bandFetched: number = 0;
        let bandScored: number = 0;
        const notForSlotBefore: number = this.skippedBy['not-for-slot'];
        const excludedBefore: ReadonlyMap<string, number> = new Map<string, number>(this.excludedMods);
        for (let i: number = 0; i < ids.length; i += FETCH_BATCH) {
            const chunk: string[] = ids.slice(i, i + FETCH_BATCH);
            let response: FetchResponse;
            try {
                response = await this.trade.fetch(chunk, undefined, this.input.signal);
            } catch (e: unknown) {
                const reason: string | undefined = stopReason(e);
                if (reason !== undefined) {
                    throw new StopRun(reason);
                }
                if (!(e instanceof TradeError)) {
                    throw e;
                }
                this.onEvent({ kind: 'warning', message: `fetch of ${chunk.length} listings failed: ${e.message}` });
                continue;
            }
            // Only ids actually fetched count, so Search deeper still tries the ones a stop or a failed fetch left.
            for (const id of chunk) {
                this.fetchedIds.add(id);
            }
            if (response.malformed.length > 0) {
                for (const m of response.malformed) {
                    this.skip('malformed', m.id);
                }
                this.onEvent({
                    kind: 'warning',
                    message: `${response.malformed.length} listing${response.malformed.length === 1 ? '' : 's'} could not be read and ${response.malformed.length === 1 ? 'was' : 'were'} skipped (details in the log).`,
                });
            }
            if (response.missing.length > 0) {
                this.missing += response.missing.length;
                this.onEvent({ kind: 'missing', listingIds: response.missing });
            }
            this.fetched += response.listings.length;
            bandFetched += response.listings.length;
            bandScored += await this.scoreListings(band, response.listings);
        }
        const notForSlot: number = this.skippedBy['not-for-slot'] - notForSlotBefore;
        if (notForSlot > 0 && notForSlot > bandFetched * NOT_FOR_SLOT_WARN_SHARE) {
            const besides: string = this.input.besides === undefined ? '' : ` ${this.input.besides}`;
            this.onEvent({
                kind: 'warning',
                message: `${band.label}: PoB won't equip ${notForSlot} of ${bandFetched} listings in ${this.input.spec.slot}${besides}, so they were skipped.`,
            });
        }
        const dropped: ExcludedModCount[] = [];
        for (const [name, count] of this.excludedMods) {
            const n: number = count - (excludedBefore.get(name) ?? 0);
            if (n > 0) {
                dropped.push({ name: name, dropped: n });
            }
        }
        if (dropped.length > 0) {
            this.onEvent({ kind: 'note', message: `${band.label}: ${excludedModText(dropped)}.` });
        }
        this.onEvent({ kind: 'band-done', band: band, fetched: bandFetched, scored: bandScored });
    }

    /** Runs the body; a stop ends it early with its reason instead of throwing. */
    public async guard(body: () => Promise<void>): Promise<void> {
        try {
            await body();
        } catch (error: unknown) {
            if (error instanceof StopRun) {
                this.stoppedReason = error.message;
                return;
            }
            const reason: string | undefined = stopReason(error);
            if (reason === undefined) {
                throw error;
            }
            this.stoppedReason = reason;
        }
    }

    public finish(): RunResult {
        const items: FilteredItem[] = junkFilter(this.evaluated, this.input.value?.minGainPct);
        const mainBands: ReadonlySet<string> = new Set<string>(
            this.input.spec.priceBands.filter((b: PriceBand) => b.role === 'main').map((b: PriceBand) => b.id),
        );
        // Each listing once: bands' divine edges can overlap, so one listing can come back from two (#111).
        const listings = (main: boolean): number =>
            new Set<string>(
                this.records.filter((r: SearchRecord) => mainBands.has(r.bandId) === main).flatMap((r: SearchRecord) => r.idList),
            ).size;
        return {
            searches: this.records,
            items: items,
            fetchedIds: [...this.fetchedIds],
            verdict: valuePick(items, this.input.value, {
                listings: listings(true),
                stoppedReason: this.stoppedReason,
                causes: this.input.emptyCauses,
                overBudgetListings: listings(false),
            }),
            counts: {
                searches: this.records.length,
                fetched: this.fetched,
                scored: this.scored,
                failed: this.failed,
                skipped: this.skipped,
                skippedBy: { ...this.skippedBy },
                excludedMods: [...this.excludedMods].map(([name, dropped]: [string, number]) => ({ name: name, dropped: dropped })),
                missing: this.missing,
            },
            stoppedReason: this.stoppedReason,
        };
    }

    private async scoreListings(band: PriceBand, listings: readonly TradeListing[]): Promise<number> {
        const toScore: ListedItem[] = [];
        for (const l of listings) {
            if (!l.identified) {
                this.skip('unidentified', l.id);
                continue;
            }
            // A hybrid the plan excludes (#38): not scored, counted per mod.
            const excluded: SearchModExclusion | undefined = excludedModOf(this.input.spec.modExclusions, l.statSources);
            if (excluded !== undefined) {
                this.excludedMods.set(excluded.name, (this.excludedMods.get(excluded.name) ?? 0) + 1);
                this.skip('excluded-mod', l.id);
                continue;
            }
            toScore.push({
                id: l.id,
                text: l.text,
                name: l.name,
                baseType: l.baseType,
                itemLevel: l.ilvl,
                statIds: l.statIds,
                statLines: l.statLines,
                seller: l.seller,
                price: l.price,
                chaosEquivalent: chaosEquivalent(l.price, this.input.chaosPerDivine),
                bandId: band.id,
                role: priceRole(chaosEquivalent(l.price, this.input.chaosPerDivine), band, budgetOf(this.input.spec.priceBands)),
                display: l.display,
            });
        }
        if (toScore.length === 0) {
            return 0;
        }
        let bandScored: number = 0;
        const onScore = (result: EngineScore): void => {
            const item: ListedItem | undefined = toScore[result.index];
            if (item === undefined) {
                return;
            }
            if (!result.ok) {
                this.failed++;
                this.onEvent({ kind: 'item-failed', listingId: item.id, message: result.message });
                return;
            }
            if (!result.validForSlot) {
                this.skip('not-for-slot', item.id);
                return;
            }
            if (result.offHandRemoved && !this.warnedOffHand) {
                this.warnedOffHand = true;
                this.onEvent({ kind: 'warning', message: offHandWarning(this.input.offHand ?? 'off-hand') });
            }
            this.scored++;
            bandScored++;
            const e: EvaluatedItem = evaluateItem(
                this.input.spec,
                this.input.baseline,
                item,
                { stats: result.stats, unparsed: result.unparsed },
                this.input.blend,
            );
            this.evaluated.push(e);
            this.onEvent({ kind: 'item', item: e });
        };
        try {
            await this.engine.score(
                toScore.map((i: ListedItem) => i.text),
                onScore,
                this.input.signal,
            );
        } catch (error: unknown) {
            throw new StopRun(`PoB engine failed: ${messageOf(error)}`);
        }
        // The engine returns normally on a cancel, with the rest unscored: the run must still read as cancelled.
        this.checkCancelled();
        return bandScored;
    }
}

export async function runSlotSearch(
    input: SlotRunInput,
    trade: RunTrade,
    engine: RunEngine,
    onEvent: (event: RunEvent) => void,
): Promise<RunResult> {
    if (input.chaosPerDivine === undefined) {
        onEvent({
            kind: 'warning',
            message: 'No divine rate: only chaos-priced listings are searched. Type a rate in to include divine-priced ones.',
        });
    }
    const runner: Runner = new Runner(input, trade, engine, onEvent);
    await runner.guard(async () => {
        for (const band of input.spec.priceBands) {
            runner.checkCancelled();
            const planned: PlannedSearch[] = await runner.searchBand(band);
            const ok: PlannedSearch[] = planned.filter((p: PlannedSearch) => p.response !== undefined);
            const counts: number[] = splitDepth(
                input.depth,
                ok.map((p: PlannedSearch) => ({ total: p.response?.total ?? 0, available: p.response?.ids.length ?? 0 })),
            );
            for (const p of planned) {
                const index: number = ok.indexOf(p);
                const record: SearchRecord = {
                    bandId: band.id,
                    option: p.search.option,
                    body: p.compiled.body,
                    predictedComplexity: p.compiled.complexity,
                    weightsUsed: p.compiled.weightsUsed,
                    droppedWeights: p.compiled.dropped.length,
                    searchId: p.response?.id,
                    total: p.response?.total,
                    ids: p.response?.ids.length ?? 0,
                    idList: p.response?.ids ?? [],
                    siteComplexity: p.response?.complexity,
                    fetchPlanned: index < 0 ? 0 : (counts[index] ?? 0),
                    error: p.error,
                };
                runner.records.push(record);
                onEvent({ kind: 'search', record: record });
            }
            const ordered: string[] = interleave(
                ok.map((p: PlannedSearch) => p.response?.ids ?? []),
                counts,
                runner.repeatFor(band),
            );
            await runner.fetchAndScore(band, ordered, true);
        }
    });
    return runner.finish();
}

/**
 * "Search deeper": the same searches at a bigger depth, with no search calls. Each band's recorded id lists are
 * split for the new depth, and only ids not fetched before are fetched and scored; the filter and the verdict
 * then run over every item, old and new. Ids that expired on the site come back as missing (V16: at least 15 min).
 */
export async function deepenSlotSearch(
    input: SlotRunInput,
    prior: PriorRun,
    trade: RunTrade,
    engine: RunEngine,
    onEvent: (event: RunEvent) => void,
): Promise<RunResult> {
    const runner: Runner = new Runner(input, trade, engine, onEvent, prior);
    await runner.guard(async () => {
        for (const band of input.spec.priceBands) {
            runner.checkCancelled();
            const ok: SearchRecord[] = prior.searches.filter(
                (r: SearchRecord) => r.bandId === band.id && r.error === undefined && r.idList.length > 0,
            );
            const counts: number[] = splitDepth(
                input.depth,
                ok.map((r: SearchRecord) => ({ total: r.total ?? 0, available: r.idList.length })),
            );
            const ordered: string[] = interleave(
                ok.map((r: SearchRecord) => r.idList),
                counts,
                runner.repeatFor(band),
            );
            await runner.fetchAndScore(band, ordered, false);
        }
    });
    return runner.finish();
}
