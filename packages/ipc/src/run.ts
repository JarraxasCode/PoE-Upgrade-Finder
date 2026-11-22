// The Run view's side of the contract (PLAN.md, UI: Run live, then done): what starts a run, what streams
// while it runs, the rate-limit panel and the summary. Seller names never cross to the renderer: buy links
// are built and opened by main, by item id.

import { array, boolean, number, oneOf, record, string, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import type { GearSlot, ListingType, SearchDepth } from './contract.ts';
import { readOptionalItemView } from './item-view.ts';
import type { ItemView } from './item-view.ts';

type Read<T> = (value: unknown, path: string) => T;

export interface RunRequest {
    readonly buildId: string;
    readonly slot: GearSlot;
    /** As typed: "300", "300c", "1.5d". */
    readonly budget: string;
    /** The min price as typed ("100d"); empty for none. Nothing cheaper is searched. */
    readonly minBudget: string;
    readonly target: string;
    readonly depth: SearchDepth;
    readonly listing: ListingType;
}

export type BandRole = 'main' | 'over';

export interface UiBand {
    readonly id: string;
    readonly label: string;
    readonly role: BandRole;
}

export interface UiSearch {
    readonly bandId: string;
    readonly option: 'chaos' | 'divine';
    readonly total: number | null;
    readonly fetchPlanned: number;
    readonly complexity: number | null;
    readonly error: string | null;
}

export interface UiPrice {
    readonly amount: number;
    readonly currency: string;
}

export type HiddenReason = 'floor' | 'no-gain' | 'low-gain' | 'duplicate' | 'dominated';
export const HIDDEN_REASONS: readonly HiddenReason[] = ['floor', 'no-gain', 'low-gain', 'duplicate', 'dominated'];

/** One stat that moves with the item equipped instead of the current one (PoB's build totals). */
export interface StatChange {
    readonly label: string;
    readonly delta: number;
    readonly unit: '' | '%';
}

export interface UiItem {
    readonly id: string;
    readonly name: string;
    readonly baseType: string;
    readonly itemLevel: number | null;
    readonly price: UiPrice | null;
    /** At the run's divine rate; null for other currencies. */
    readonly chaos: number | null;
    readonly bandId: string;
    /** Percent; null when PoB's change has no percentage (from 0 or infinity). */
    readonly gainPct: number | null;
    readonly dpsPct: number | null;
    readonly ehpPct: number | null;
    readonly floorsPass: boolean;
    readonly failedFloors: readonly string[];
    readonly flags: readonly string[];
    readonly missedTargets: readonly string[];
    readonly notes: readonly string[];
    readonly unparsed: readonly string[];
    /** The in-game item text (the detail panel). */
    readonly text: string;
    /** The tooltip: image, properties and mod groups; null when the fetch gave none. */
    readonly view: ItemView | null;
    /** Stats that change against the current item, in reading order. */
    readonly changes: readonly StatChange[];
    readonly hasBuyLink: boolean;
    /** Set in the summary (the junk filter runs at the end); null while live or when shown. */
    readonly hidden: HiddenReason | null;
    readonly hiddenBy: string | null;
}

/** One weighted stat PoB searched for, named by ModCatalog (the stat id when the list is unavailable). */
export interface SearchedStat {
    readonly statId: string;
    readonly label: string;
    readonly weight: number;
}

/** The weight review list: PoB's weights before the user's edits. */
export interface WeightPreview {
    readonly buildId: string;
    readonly slot: GearSlot;
    readonly target: string;
    /** PoB's weights, heaviest first. */
    readonly weights: readonly SearchedStat[];
    /** True when the generator's result came from the cache. */
    readonly cached: boolean;
}

export interface RunHeader {
    readonly runId: string;
    readonly buildId: string;
    readonly buildName: string;
    readonly slot: GearSlot;
    readonly league: string;
    readonly budgetLabel: string;
    readonly budgetChaos: number;
    readonly targetLabel: string;
    readonly depth: SearchDepth;
    readonly perBand: number;
    readonly listing: ListingType;
    readonly minGainPct: number;
    /** DPS share of the overall gain (0..1); EHP gets the rest. */
    readonly blend: number;
    readonly chaosPerDivine: number | null;
    readonly startedAtMs: number;
    readonly baselineDamage: number;
    readonly baselineEhp: number | null;
    readonly currentItem: string;
    /** The item in the slot now, as the tooltip draws it; null when the slot is empty or PoB couldn't describe it. */
    readonly currentView: ItemView | null;
    readonly weightedStats: number;
    readonly hardNeeds: readonly string[];
    /** PoB's weights, heaviest first. */
    readonly searchedFor: readonly SearchedStat[];
    readonly bands: readonly UiBand[];
}

export type RunPhase = 'preparing' | 'searching' | 'paused' | 'done' | 'stopped' | 'cancelled' | 'failed';
export const RUN_PHASES: readonly RunPhase[] = ['preparing', 'searching', 'paused', 'done', 'stopped', 'cancelled', 'failed'];

export type FeedLevel = 'info' | 'warn' | 'error';

export interface FeedEntry {
    readonly atMs: number;
    readonly level: FeedLevel;
    readonly text: string;
}

export interface RunCountsUi {
    readonly searches: number;
    readonly fetched: number;
    readonly scored: number;
    readonly failed: number;
    readonly skipped: number;
    readonly missing: number;
}

export interface RunSummaryUi {
    readonly verdict: 'pick' | 'no-upgrade';
    readonly note: string;
    readonly pickId: string | null;
    readonly bestId: string | null;
    readonly overBudgetIds: readonly string[];
    readonly counts: RunCountsUi;
    readonly stoppedReason: string | null;
    readonly finishedAtMs: number;
    readonly seconds: number;
    /** Every scored item, hidden ones included, with the junk filter's reasons. */
    readonly items: readonly UiItem[];
    readonly runFile: string | null;
}

export interface LimitWindow {
    readonly count: number;
    readonly allowed: number;
    readonly limit: number;
    readonly periodS: number;
}

export interface LimitPolicy {
    readonly policy: string;
    readonly windows: readonly LimitWindow[];
}

export interface LimitPanel {
    readonly policies: readonly LimitPolicy[];
    /** The limiter's current wait, if any. */
    readonly wait: { readonly policy: string; readonly untilMs: number; readonly reason: string } | null;
}

/** Everything the Run view needs to redraw (after a reload of the window). */
export interface RunSnapshot {
    readonly header: RunHeader;
    readonly phase: RunPhase;
    readonly searches: readonly UiSearch[];
    readonly items: readonly UiItem[];
    readonly bandsDone: readonly string[];
    readonly feed: readonly FeedEntry[];
    readonly summary: RunSummaryUi | null;
}

export type RunEventUi =
    | { readonly kind: 'run-started'; readonly header: RunHeader }
    | { readonly kind: 'run-phase'; readonly runId: string; readonly phase: RunPhase }
    | { readonly kind: 'run-search'; readonly runId: string; readonly search: UiSearch }
    | { readonly kind: 'run-item'; readonly runId: string; readonly item: UiItem }
    | { readonly kind: 'run-band-done'; readonly runId: string; readonly bandId: string }
    | { readonly kind: 'run-feed'; readonly runId: string; readonly entry: FeedEntry }
    | { readonly kind: 'run-done'; readonly runId: string; readonly summary: RunSummaryUi }
    /** Search deeper started: the new depth in the header, the searches with their new fetch plans; items stay. */
    | { readonly kind: 'run-deepen'; readonly runId: string; readonly header: RunHeader; readonly searches: readonly UiSearch[] };

// Checks ---------------------------------------------------------------------------------------------------

function finite(value: unknown, path: string): number {
    const n: number = number(value, path);
    if (!Number.isFinite(n)) {
        throw new ValidationError(`${path}: expected a finite number`);
    }
    return n;
}

function nullable<T>(read: Read<T>): Read<T | null> {
    return (value: unknown, path: string): T | null => (value === null ? null : read(value, path));
}

const optString: Read<string | null> = nullable(string);
const optNumber: Read<number | null> = nullable(finite);
const strings: Read<readonly string[]> = (value: unknown, path: string) => array(value, path, string);

function band(value: unknown, path: string): UiBand {
    const r: JsonRecord = record(value, path);
    return { id: string(r['id'], `${path}.id`), label: string(r['label'], `${path}.label`), role: oneOf(r['role'], `${path}.role`, ['main', 'over'] as const) };
}

export function readUiSearch(value: unknown, path: string): UiSearch {
    const r: JsonRecord = record(value, path);
    return {
        bandId: string(r['bandId'], `${path}.bandId`),
        option: oneOf(r['option'], `${path}.option`, ['chaos', 'divine'] as const),
        total: optNumber(r['total'], `${path}.total`),
        fetchPlanned: finite(r['fetchPlanned'], `${path}.fetchPlanned`),
        complexity: optNumber(r['complexity'], `${path}.complexity`),
        error: optString(r['error'], `${path}.error`),
    };
}

function price(value: unknown, path: string): UiPrice {
    const r: JsonRecord = record(value, path);
    return { amount: finite(r['amount'], `${path}.amount`), currency: string(r['currency'], `${path}.currency`) };
}

function statChange(value: unknown, path: string): StatChange {
    const r: JsonRecord = record(value, path);
    return { label: string(r['label'], `${path}.label`), delta: finite(r['delta'], `${path}.delta`), unit: oneOf(r['unit'], `${path}.unit`, ['', '%'] as const) };
}

export function readUiItem(value: unknown, path: string): UiItem {
    const r: JsonRecord = record(value, path);
    return {
        id: string(r['id'], `${path}.id`),
        name: string(r['name'], `${path}.name`),
        baseType: string(r['baseType'], `${path}.baseType`),
        itemLevel: optNumber(r['itemLevel'], `${path}.itemLevel`),
        price: nullable(price)(r['price'], `${path}.price`),
        chaos: optNumber(r['chaos'], `${path}.chaos`),
        bandId: string(r['bandId'], `${path}.bandId`),
        gainPct: optNumber(r['gainPct'], `${path}.gainPct`),
        dpsPct: optNumber(r['dpsPct'], `${path}.dpsPct`),
        ehpPct: optNumber(r['ehpPct'], `${path}.ehpPct`),
        floorsPass: boolean(r['floorsPass'], `${path}.floorsPass`),
        failedFloors: strings(r['failedFloors'], `${path}.failedFloors`),
        flags: strings(r['flags'], `${path}.flags`),
        missedTargets: strings(r['missedTargets'], `${path}.missedTargets`),
        notes: strings(r['notes'], `${path}.notes`),
        unparsed: strings(r['unparsed'], `${path}.unparsed`),
        text: string(r['text'], `${path}.text`),
        view: readOptionalItemView(r['view'], `${path}.view`),
        changes: r['changes'] === undefined ? [] : array(r['changes'], `${path}.changes`, statChange),
        hasBuyLink: boolean(r['hasBuyLink'], `${path}.hasBuyLink`),
        hidden: nullable((v: unknown, p: string) => oneOf(v, p, HIDDEN_REASONS))(r['hidden'], `${path}.hidden`),
        hiddenBy: optString(r['hiddenBy'], `${path}.hiddenBy`),
    };
}

const SLOTS = ['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Weapon 1', 'Weapon 2'] as const;

function searchedStat(v: unknown, p: string): SearchedStat {
    const s: JsonRecord = record(v, p);
    return { statId: string(s['statId'], `${p}.statId`), label: string(s['label'], `${p}.label`), weight: finite(s['weight'], `${p}.weight`) };
}

export function readWeightPreview(value: unknown, path: string): WeightPreview {
    const r: JsonRecord = record(value, path);
    return {
        buildId: string(r['buildId'], `${path}.buildId`),
        slot: oneOf(r['slot'], `${path}.slot`, SLOTS),
        target: string(r['target'], `${path}.target`),
        weights: array(r['weights'], `${path}.weights`, searchedStat),
        cached: boolean(r['cached'], `${path}.cached`),
    };
}

export function readRunHeader(value: unknown, path: string): RunHeader {
    const r: JsonRecord = record(value, path);
    return {
        runId: string(r['runId'], `${path}.runId`),
        buildId: string(r['buildId'], `${path}.buildId`),
        buildName: string(r['buildName'], `${path}.buildName`),
        slot: oneOf(r['slot'], `${path}.slot`, SLOTS),
        league: string(r['league'], `${path}.league`),
        budgetLabel: string(r['budgetLabel'], `${path}.budgetLabel`),
        budgetChaos: finite(r['budgetChaos'], `${path}.budgetChaos`),
        targetLabel: string(r['targetLabel'], `${path}.targetLabel`),
        depth: oneOf(r['depth'], `${path}.depth`, ['thorough', 'normal', 'quick'] as const),
        perBand: finite(r['perBand'], `${path}.perBand`),
        listing: oneOf(r['listing'], `${path}.listing`, ['securable', 'online'] as const),
        minGainPct: finite(r['minGainPct'], `${path}.minGainPct`),
        blend: finite(r['blend'], `${path}.blend`),
        chaosPerDivine: optNumber(r['chaosPerDivine'], `${path}.chaosPerDivine`),
        startedAtMs: finite(r['startedAtMs'], `${path}.startedAtMs`),
        baselineDamage: finite(r['baselineDamage'], `${path}.baselineDamage`),
        baselineEhp: optNumber(r['baselineEhp'], `${path}.baselineEhp`),
        currentItem: string(r['currentItem'], `${path}.currentItem`),
        currentView: readOptionalItemView(r['currentView'], `${path}.currentView`),
        weightedStats: finite(r['weightedStats'], `${path}.weightedStats`),
        hardNeeds: strings(r['hardNeeds'], `${path}.hardNeeds`),
        searchedFor: array(r['searchedFor'], `${path}.searchedFor`, searchedStat),
        bands: array(r['bands'], `${path}.bands`, band),
    };
}

const FEED_LEVELS: readonly FeedLevel[] = ['info', 'warn', 'error'];

function feedEntry(value: unknown, path: string): FeedEntry {
    const r: JsonRecord = record(value, path);
    return { atMs: finite(r['atMs'], `${path}.atMs`), level: oneOf(r['level'], `${path}.level`, FEED_LEVELS), text: string(r['text'], `${path}.text`) };
}

function counts(value: unknown, path: string): RunCountsUi {
    const r: JsonRecord = record(value, path);
    return {
        searches: finite(r['searches'], `${path}.searches`),
        fetched: finite(r['fetched'], `${path}.fetched`),
        scored: finite(r['scored'], `${path}.scored`),
        failed: finite(r['failed'], `${path}.failed`),
        skipped: finite(r['skipped'], `${path}.skipped`),
        missing: finite(r['missing'], `${path}.missing`),
    };
}

export function readRunSummary(value: unknown, path: string): RunSummaryUi {
    const r: JsonRecord = record(value, path);
    return {
        verdict: oneOf(r['verdict'], `${path}.verdict`, ['pick', 'no-upgrade'] as const),
        note: string(r['note'], `${path}.note`),
        pickId: optString(r['pickId'], `${path}.pickId`),
        bestId: optString(r['bestId'], `${path}.bestId`),
        overBudgetIds: strings(r['overBudgetIds'], `${path}.overBudgetIds`),
        counts: counts(r['counts'], `${path}.counts`),
        stoppedReason: optString(r['stoppedReason'], `${path}.stoppedReason`),
        finishedAtMs: finite(r['finishedAtMs'], `${path}.finishedAtMs`),
        seconds: finite(r['seconds'], `${path}.seconds`),
        items: array(r['items'], `${path}.items`, readUiItem),
        runFile: optString(r['runFile'], `${path}.runFile`),
    };
}

function limitPolicy(value: unknown, path: string): LimitPolicy {
    const r: JsonRecord = record(value, path);
    return {
        policy: string(r['policy'], `${path}.policy`),
        windows: array(r['windows'], `${path}.windows`, (v: unknown, p: string): LimitWindow => {
            const w: JsonRecord = record(v, p);
            return { count: finite(w['count'], `${p}.count`), allowed: finite(w['allowed'], `${p}.allowed`), limit: finite(w['limit'], `${p}.limit`), periodS: finite(w['periodS'], `${p}.periodS`) };
        }),
    };
}

export function readLimitPanel(value: unknown, path: string): LimitPanel {
    const r: JsonRecord = record(value, path);
    return {
        policies: array(r['policies'], `${path}.policies`, limitPolicy),
        wait: nullable((v: unknown, p: string) => {
            const w: JsonRecord = record(v, p);
            return { policy: string(w['policy'], `${p}.policy`), untilMs: finite(w['untilMs'], `${p}.untilMs`), reason: string(w['reason'], `${p}.reason`) };
        })(r['wait'], `${path}.wait`),
    };
}

export function readRunSnapshot(value: unknown, path: string): RunSnapshot {
    const r: JsonRecord = record(value, path);
    return {
        header: readRunHeader(r['header'], `${path}.header`),
        phase: oneOf(r['phase'], `${path}.phase`, RUN_PHASES),
        searches: array(r['searches'], `${path}.searches`, readUiSearch),
        items: array(r['items'], `${path}.items`, readUiItem),
        bandsDone: strings(r['bandsDone'], `${path}.bandsDone`),
        feed: array(r['feed'], `${path}.feed`, feedEntry),
        summary: nullable(readRunSummary)(r['summary'], `${path}.summary`),
    };
}

/** Undefined for a kind that isn't a run event. */
export function readRunEvent(value: JsonRecord): RunEventUi | undefined {
    const runId = (): string => string(value['runId'], 'event.runId');
    switch (value['kind']) {
        case 'run-started':
            return { kind: 'run-started', header: readRunHeader(value['header'], 'event.header') };
        case 'run-phase':
            return { kind: 'run-phase', runId: runId(), phase: oneOf(value['phase'], 'event.phase', RUN_PHASES) };
        case 'run-search':
            return { kind: 'run-search', runId: runId(), search: readUiSearch(value['search'], 'event.search') };
        case 'run-item':
            return { kind: 'run-item', runId: runId(), item: readUiItem(value['item'], 'event.item') };
        case 'run-band-done':
            return { kind: 'run-band-done', runId: runId(), bandId: string(value['bandId'], 'event.bandId') };
        case 'run-feed':
            return { kind: 'run-feed', runId: runId(), entry: feedEntry(value['entry'], 'event.entry') };
        case 'run-done':
            return { kind: 'run-done', runId: runId(), summary: readRunSummary(value['summary'], 'event.summary') };
        case 'run-deepen':
            return { kind: 'run-deepen', runId: runId(), header: readRunHeader(value['header'], 'event.header'), searches: array(value['searches'], 'event.searches', readUiSearch) };
        default:
            return undefined;
    }
}
