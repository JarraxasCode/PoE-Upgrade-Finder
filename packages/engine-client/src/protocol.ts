// Types for the engine protocol (engine/README.md, "The dispatcher") and runtime validation of every
// message that comes in. Non-finite numbers arrive as strings and are decoded to JS numbers here.

import { boolean, isRecord, luaArray, number, oneOf, optional, ProtocolError, record, string } from './check.ts';
import type { JsonRecord } from './check.ts';
import { isEngineNumber, isEngineValue, toNumber } from './values.ts';
import { messageOf } from '@poe-upgrade-finder/validate';
import { ITEM_INFLUENCES, ITEM_MOD_KINDS, ITEM_RARITIES, ITEM_TONES } from '@poe-upgrade-finder/vocab';
import type { ItemMod, ItemPart, ItemView } from '@poe-upgrade-finder/vocab';

// Requests ----------------------------------------------------------------------------------------------

/** A damage target as requested. Indices are 1-based, as in PoB. */
export type TargetRequest =
    | { readonly kind: 'saved' }
    | { readonly kind: 'fullDps' }
    | { readonly kind: 'skill'; readonly group: number; readonly activeSkill: number; readonly part?: number };

export type CommandName =
    'ping' | 'loadBuild' | 'stats' | 'strip' | 'tradeQuery' | 'score' | 'baseTypes' | 'slotData' | 'uniques' | 'shutdown';

// Messages ----------------------------------------------------------------------------------------------

export interface EngineWarning {
    readonly code: string;
    readonly message: string;
}

export interface EngineErrorInfo {
    readonly code: string;
    readonly message: string;
}

export interface ReadyEvent {
    readonly type: 'ready';
    readonly pobVersion: string;
    readonly gcEvery: number;
}

export interface FatalEvent {
    readonly type: 'fatal';
    readonly error: EngineErrorInfo;
}

export interface StreamEvent {
    readonly type: 'stream';
    readonly id: number;
    readonly event: 'progress' | 'item';
    readonly data: unknown;
}

export interface FinalMessage {
    readonly type: 'final';
    readonly id: number;
    readonly ok: boolean;
    readonly data: unknown;
    readonly error: EngineErrorInfo | undefined;
    readonly warnings: readonly EngineWarning[];
}

export type EngineMessage = ReadyEvent | FatalEvent | StreamEvent | FinalMessage;

function readErrorInfo(value: unknown, path: string): EngineErrorInfo {
    const r: JsonRecord = record(value, path);
    return { code: string(r['code'], `${path}.code`), message: string(r['message'], `${path}.message`) };
}

function readWarning(value: unknown, path: string): EngineWarning {
    return readErrorInfo(value, path);
}

/** Parses and validates one stdout line. */
export function parseMessage(line: string): EngineMessage {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch (error: unknown) {
        throw new ProtocolError(`not JSON: ${messageOf(error)}`);
    }
    const m: JsonRecord = record(value, 'message');
    const event: unknown = m['event'];
    if (event === 'ready') {
        const data: JsonRecord = record(m['data'], 'ready.data');
        return {
            type: 'ready',
            pobVersion: string(data['pobVersion'], 'ready.data.pobVersion'),
            gcEvery: number(data['gcEvery'], 'ready.data.gcEvery'),
        };
    }
    if (event === 'fatal') {
        return { type: 'fatal', error: readErrorInfo(m['error'], 'fatal.error') };
    }
    const id: number = number(m['id'], 'message.id');
    if (event !== undefined) {
        return { type: 'stream', id: id, event: oneOf(event, 'message.event', ['progress', 'item'] as const), data: m['data'] };
    }
    const ok: boolean = boolean(m['ok'], 'message.ok');
    return {
        type: 'final',
        id: id,
        ok: ok,
        data: m['data'],
        error: ok ? undefined : readErrorInfo(m['error'], 'message.error'),
        warnings: luaArray(m['warnings'], 'message.warnings', readWarning),
    };
}

// Results -----------------------------------------------------------------------------------------------

export interface SkillDpsRow {
    readonly name: string;
    readonly dps: number;
    readonly count: number;
    readonly skillPart: string | undefined;
    readonly trigger: string | undefined;
    readonly source: string | undefined;
}

/** PoB's numbers for one calc. `values` holds the "What we read" keys; a key PoB left out is absent. */
export interface StatBlock {
    readonly damage: number;
    readonly values: Readonly<Record<string, number | boolean>>;
    readonly skillDps: readonly SkillDpsRow[] | undefined;
}

export type ResolvedTarget =
    | { readonly kind: 'fullDps'; readonly saved: boolean }
    | {
          readonly kind: 'skill';
          readonly saved: boolean;
          readonly group: number;
          readonly activeSkill: number;
          readonly part: number | undefined;
          readonly name: string;
      };

export interface ActiveSkillInfo {
    readonly index: number;
    readonly name: string;
    readonly minion: string | undefined;
    readonly parts: readonly string[];
    readonly skillPart: number | undefined;
}

export interface SocketGroupInfo {
    readonly index: number;
    readonly name: string;
    readonly enabled: boolean;
    readonly slot: string | undefined;
    readonly includeInFullDPS: boolean;
    readonly mainActiveSkill: number | undefined;
    readonly activeSkills: readonly ActiveSkillInfo[];
}

export interface ItemInfo {
    readonly name: string;
    readonly base: string;
    readonly rarity: string;
    /** PoB's item type ("Boots", "One Handed Sword"): the slot data's key. Undefined when PoB has no base for it. */
    readonly type: string | undefined;
}

export interface EquippedItem extends ItemInfo {
    readonly slot: string;
    readonly text: string;
    /** The tooltip, from PoB's parsed item (engine/lua/itemview.lua); undefined if PoB couldn't build it. */
    readonly view: PobItemView | undefined;
}

/** An equipped item's tooltip groups, as PoB's own tooltip has them: the tooltip's item without the image, which the app adds. */
export interface PobItemView extends Omit<ItemView, 'icon' | 'width' | 'height'> {
    /** The base type without PoB's "(...)" suffixes: the key for the item's art. */
    readonly baseName: string;
}

export interface BuildInfo {
    readonly className: string | undefined;
    readonly ascendClassName: string | undefined;
    readonly level: number | undefined;
    readonly treeVersion: string | undefined;
    readonly mainSocketGroup: number | undefined;
}

export interface LoadBuildData {
    readonly buildId: string;
    readonly pobVersion: string;
    readonly info: BuildInfo;
    readonly skills: readonly SocketGroupInfo[];
    readonly target: ResolvedTarget;
    readonly baseline: StatBlock;
    readonly equipped: readonly EquippedItem[];
}

export interface StatsData {
    readonly target: ResolvedTarget;
    readonly stats: StatBlock;
}

/** What the slot's item carries itself, from PoB's parsed mods (#34): the site's pseudo totals for it. */
export interface StripItemTotals {
    readonly Chaos?: number;
    readonly Fire?: number;
    readonly Cold?: number;
    readonly Lightning?: number;
    readonly Str?: number;
    readonly Dex?: number;
    readonly Int?: number;
}

const ITEM_TOTAL_KEYS: readonly (keyof StripItemTotals)[] = ['Chaos', 'Fire', 'Cold', 'Lightning', 'Str', 'Dex', 'Int'];

export interface StripData extends StatsData {
    readonly slot: string;
    /** Undefined for an empty slot. */
    readonly itemTotals: StripItemTotals | undefined;
}

export interface ModWeight {
    readonly id: string;
    readonly weight: number;
    readonly meanStatDiff: number;
    readonly invert: boolean;
}

export interface PobStatFilter {
    readonly id: string;
    readonly weight: number | undefined;
}

export interface PobStatGroup {
    readonly type: string;
    readonly filters: readonly PobStatFilter[];
}

/** PoB's generated trade query: its stat groups, typed, plus the whole query as PoB built it. */
export interface PobQuery {
    readonly stats: readonly PobStatGroup[];
    readonly raw: JsonRecord;
}

export interface TradeQueryData {
    readonly slot: string;
    readonly target: ResolvedTarget;
    readonly item: ItemInfo;
    readonly category: { readonly query: string; readonly generator: string };
    readonly statWeights: readonly { readonly stat: string; readonly weight: number }[];
    readonly affixQuality: number | undefined;
    readonly baseStatValue: number;
    readonly weights: readonly ModWeight[];
    readonly query: PobQuery;
    readonly queryError: string | undefined;
    readonly calcs: number;
    readonly seconds: number;
    readonly log: readonly string[];
}

/**
 * The options of PoB's trade query generator (StartQuery), as tradeQuery's `options`. Each one left out keeps
 * the engine's default: no corrupted, scourge or talisman mods, eldritch "None" (none added), no mirrored
 * items, no maximum level (engine/lua/generator.lua).
 */
export interface GeneratorOptions {
    readonly includeCorrupted?: boolean;
    readonly includeScourge?: boolean;
    readonly includeTalisman?: boolean;
    readonly includeEldritch?: 'None' | 'Copy Current' | 'Keep regular' | 'Keep regular+presence' | 'Remove';
    readonly includeMirrored?: boolean;
    readonly maxLevel?: number;
}

export interface TradeQueryProgress {
    readonly calcs: number;
    readonly seconds: number;
}

export type ScoreItemResult =
    | {
          readonly index: number;
          readonly ok: true;
          readonly item: ItemInfo;
          readonly stats: StatBlock;
          readonly unparsed: readonly string[];
          readonly validForSlot: boolean;
          /**
           * Scored into Weapon 1 with Weapon 2 emptied: the item can't be held beside the saved off-hand (a
           * two-hander, a bow without a quiver), so its gain includes losing the off-hand (#39, #101).
           */
          readonly offHandRemoved: boolean;
      }
    | { readonly index: number; readonly ok: false; readonly error: EngineErrorInfo };

export interface ScoreBatchSummary {
    readonly count: number;
    readonly failed: number;
    readonly gcRuns: number;
    readonly seconds: number;
    /** How many items of the batch were scored with Weapon 2 emptied. */
    readonly offHandRemoved: number;
}

export interface PingData {
    readonly pobVersion: string;
    readonly buildId: string | undefined;
    readonly gcEvery: number;
    readonly scoresSinceGc: number;
    readonly gcRuns: number;
    readonly luaHeapMb: number;
}

// Readers -----------------------------------------------------------------------------------------------

function engineNumber(value: unknown, path: string): number {
    if (isEngineNumber(value)) {
        return toNumber(value);
    }
    throw new ProtocolError(`${path}: expected a number, got ${JSON.stringify(value)}`);
}

function optString(r: JsonRecord, key: string, path: string): string | undefined {
    return optional(r[key], `${path}.${key}`, string);
}

function optNumber(r: JsonRecord, key: string, path: string): number | undefined {
    return optional(r[key], `${path}.${key}`, number);
}

function readSkillDps(value: unknown, path: string): SkillDpsRow {
    const r: JsonRecord = record(value, path);
    return {
        name: string(r['name'], `${path}.name`),
        dps: engineNumber(r['dps'], `${path}.dps`),
        count: number(r['count'], `${path}.count`),
        skillPart: optString(r, 'skillPart', path),
        trigger: optString(r, 'trigger', path),
        source: optString(r, 'source', path),
    };
}

export function readStatBlock(value: unknown, path: string): StatBlock {
    const r: JsonRecord = record(value, path);
    const rawValues: JsonRecord = record(r['values'], `${path}.values`);
    const values: Record<string, number | boolean> = {};
    for (const [key, v] of Object.entries(rawValues)) {
        if (!isEngineValue(v)) {
            throw new ProtocolError(`${path}.values.${key}: expected a number or boolean, got ${JSON.stringify(v)}`);
        }
        values[key] = typeof v === 'boolean' ? v : toNumber(v);
    }
    return {
        damage: engineNumber(r['damage'], `${path}.damage`),
        values: values,
        skillDps: optional(r['skillDps'], `${path}.skillDps`, (v: unknown, p: string) => luaArray(v, p, readSkillDps)),
    };
}

export function readTarget(value: unknown, path: string): ResolvedTarget {
    const r: JsonRecord = record(value, path);
    const kind: 'fullDps' | 'skill' = oneOf(r['kind'], `${path}.kind`, ['fullDps', 'skill'] as const);
    const saved: boolean = boolean(r['saved'], `${path}.saved`);
    if (kind === 'fullDps') {
        return { kind: 'fullDps', saved: saved };
    }
    return {
        kind: 'skill',
        saved: saved,
        group: number(r['group'], `${path}.group`),
        activeSkill: number(r['activeSkill'], `${path}.activeSkill`),
        part: optNumber(r, 'part', path),
        name: string(r['name'], `${path}.name`),
    };
}

function readItemInfo(value: unknown, path: string): ItemInfo {
    const r: JsonRecord = record(value, path);
    return {
        name: string(r['name'], `${path}.name`),
        base: string(r['base'], `${path}.base`),
        rarity: string(r['rarity'], `${path}.rarity`),
        // Cached generator results from before the field have none.
        type: r['type'] === undefined || r['type'] === null ? undefined : string(r['type'], `${path}.type`),
    };
}

function readViewPart(value: unknown, path: string): ItemPart {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), tone: oneOf(r['tone'], `${path}.tone`, ITEM_TONES) };
}

function readViewMod(value: unknown, path: string): ItemMod {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), kind: oneOf(r['kind'], `${path}.kind`, ITEM_MOD_KINDS) };
}

export function readPobItemView(value: unknown, path: string): PobItemView {
    const r: JsonRecord = record(value, path);
    const ilvl: unknown = r['itemLevel'];
    return {
        rarity: oneOf(r['rarity'], `${path}.rarity`, ITEM_RARITIES),
        name: string(r['name'], `${path}.name`),
        typeLine: string(r['typeLine'], `${path}.typeLine`),
        baseName: string(r['baseName'], `${path}.baseName`),
        influences: luaArray(r['influences'], `${path}.influences`, (v: unknown, p: string) => oneOf(v, p, ITEM_INFLUENCES)),
        properties: luaArray(r['properties'], `${path}.properties`, (v: unknown, p: string) => luaArray(v, p, readViewPart)),
        requirements: luaArray(r['requirements'], `${path}.requirements`, readViewPart),
        sockets: string(r['sockets'], `${path}.sockets`),
        itemLevel: typeof ilvl === 'number' && Number.isFinite(ilvl) ? ilvl : null,
        enchants: luaArray(r['enchants'], `${path}.enchants`, readViewMod),
        implicits: luaArray(r['implicits'], `${path}.implicits`, readViewMod),
        explicits: luaArray(r['explicits'], `${path}.explicits`, readViewMod),
        corrupted: boolean(r['corrupted'], `${path}.corrupted`),
        mirrored: boolean(r['mirrored'], `${path}.mirrored`),
    };
}

/** A view that doesn't check out is dropped (the tooltip is optional); the item itself still loads. */
function optionalView(value: unknown, path: string): PobItemView | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    try {
        return readPobItemView(value, path);
    } catch (error: unknown) {
        if (error instanceof ProtocolError) {
            return undefined;
        }
        throw error;
    }
}

function readEquipped(value: unknown, path: string): EquippedItem {
    const r: JsonRecord = record(value, path);
    return {
        ...readItemInfo(r, path),
        slot: string(r['slot'], `${path}.slot`),
        text: string(r['text'], `${path}.text`),
        view: optionalView(r['view'], `${path}.view`),
    };
}

function readActiveSkill(value: unknown, path: string): ActiveSkillInfo {
    const r: JsonRecord = record(value, path);
    return {
        index: number(r['index'], `${path}.index`),
        name: string(r['name'], `${path}.name`),
        minion: optString(r, 'minion', path),
        parts: luaArray(r['parts'], `${path}.parts`, string),
        skillPart: optNumber(r, 'skillPart', path),
    };
}

function readSocketGroup(value: unknown, path: string): SocketGroupInfo {
    const r: JsonRecord = record(value, path);
    return {
        index: number(r['index'], `${path}.index`),
        name: string(r['name'], `${path}.name`),
        enabled: boolean(r['enabled'], `${path}.enabled`),
        slot: optString(r, 'slot', path),
        includeInFullDPS: boolean(r['includeInFullDPS'], `${path}.includeInFullDPS`),
        mainActiveSkill: optNumber(r, 'mainActiveSkill', path),
        activeSkills: luaArray(r['activeSkills'], `${path}.activeSkills`, readActiveSkill),
    };
}

export function readLoadBuild(value: unknown): LoadBuildData {
    const path: string = 'loadBuild';
    const r: JsonRecord = record(value, path);
    const info: JsonRecord = record(r['info'], `${path}.info`);
    return {
        buildId: string(r['buildId'], `${path}.buildId`),
        pobVersion: string(r['pobVersion'], `${path}.pobVersion`),
        info: {
            className: optString(info, 'className', `${path}.info`),
            ascendClassName: optString(info, 'ascendClassName', `${path}.info`),
            level: optNumber(info, 'level', `${path}.info`),
            treeVersion: optString(info, 'treeVersion', `${path}.info`),
            mainSocketGroup: optNumber(info, 'mainSocketGroup', `${path}.info`),
        },
        skills: luaArray(r['skills'], `${path}.skills`, readSocketGroup),
        target: readTarget(r['target'], `${path}.target`),
        baseline: readStatBlock(r['baseline'], `${path}.baseline`),
        equipped: luaArray(r['equipped'], `${path}.equipped`, readEquipped),
    };
}

export function readStats(value: unknown): StatsData {
    const r: JsonRecord = record(value, 'stats');
    return { target: readTarget(r['target'], 'stats.target'), stats: readStatBlock(r['stats'], 'stats.stats') };
}

export function readStrip(value: unknown): StripData {
    const r: JsonRecord = record(value, 'strip');
    return {
        target: readTarget(r['target'], 'strip.target'),
        stats: readStatBlock(r['stats'], 'strip.stats'),
        slot: string(r['slot'], 'strip.slot'),
        itemTotals: readItemTotals(r['itemTotals'], 'strip.itemTotals'),
    };
}

function readItemTotals(value: unknown, path: string): StripItemTotals | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const r: JsonRecord = record(value, path);
    const totals: Partial<Record<keyof StripItemTotals, number>> = {};
    for (const key of ITEM_TOTAL_KEYS) {
        const n: number | undefined = optNumber(r, key, path);
        if (n !== undefined) {
            totals[key] = n;
        }
    }
    return totals;
}

function readModWeight(value: unknown, path: string): ModWeight {
    const r: JsonRecord = record(value, path);
    return {
        id: string(r['id'], `${path}.id`),
        // PoB's generator can produce non-finite weights (sent as "Infinity"/"NaN"); spec.ts drops them.
        weight: engineNumber(r['weight'], `${path}.weight`),
        meanStatDiff: engineNumber(r['meanStatDiff'], `${path}.meanStatDiff`),
        invert: boolean(r['invert'], `${path}.invert`),
    };
}

function readPobFilter(value: unknown, path: string): PobStatFilter {
    const r: JsonRecord = record(value, path);
    const v: unknown = r['value'];
    return {
        id: string(r['id'], `${path}.id`),
        weight: isRecord(v) ? optional(v['weight'], `${path}.value.weight`, engineNumber) : undefined,
    };
}

function readPobGroup(value: unknown, path: string): PobStatGroup {
    const r: JsonRecord = record(value, path);
    return { type: string(r['type'], `${path}.type`), filters: luaArray(r['filters'], `${path}.filters`, readPobFilter) };
}

export function readTradeQuery(value: unknown): TradeQueryData {
    const path: string = 'tradeQuery';
    const r: JsonRecord = record(value, path);
    const category: JsonRecord = record(r['category'], `${path}.category`);
    const query: JsonRecord = record(r['query'], `${path}.query`);
    return {
        slot: string(r['slot'], `${path}.slot`),
        target: readTarget(r['target'], `${path}.target`),
        item: readItemInfo(r['item'], `${path}.item`),
        category: {
            query: string(category['query'], `${path}.category.query`),
            generator: string(category['generator'], `${path}.category.generator`),
        },
        statWeights: luaArray(r['statWeights'], `${path}.statWeights`, (v: unknown, p: string) => {
            const w: JsonRecord = record(v, p);
            return { stat: string(w['stat'], `${p}.stat`), weight: number(w['weight'], `${p}.weight`) };
        }),
        affixQuality: optNumber(r, 'affixQuality', path),
        baseStatValue: number(r['baseStatValue'], `${path}.baseStatValue`),
        weights: luaArray(r['weights'], `${path}.weights`, readModWeight),
        query: { stats: luaArray(query['stats'], `${path}.query.stats`, readPobGroup), raw: query },
        queryError: optString(r, 'queryError', path),
        calcs: number(r['calcs'], `${path}.calcs`),
        seconds: number(r['seconds'], `${path}.seconds`),
        log: luaArray(r['log'], `${path}.log`, string),
    };
}

/** One rolling line's weight on a unique (#113): the gain per point of the site's value for the line. */
export interface UniqueWeight {
    readonly id: string;
    readonly weight: number;
    /** PoB's line, with its range, e.g. "+(150-200) to maximum Life". */
    readonly line: string;
}

/** One rolling line's value on the site at its lowest and highest roll (the mean of the site's "#" numbers). */
export interface UniqueRoll {
    readonly id: string;
    readonly line: string;
    readonly low: number;
    readonly high: number;
}

/** One unique PoB knows for the item type, scored in the build (engine/lua/uniques.lua). */
export interface UniqueInfo {
    readonly name: string;
    readonly base: string;
    /** The site's name for the base. */
    readonly tradeType: string;
    /** The variant the weights are for (PoB's default, the current one); null when the unique has none. */
    readonly variant: number | null;
    readonly variants: number;
    readonly scoreLow: number;
    readonly scoreMid: number;
    readonly scoreHigh: number;
    /** scoreHigh minus the equipped item's score. */
    readonly change: number;
    /** Heaviest first; lines that gain nothing are left out. */
    readonly weights: readonly UniqueWeight[];
    /** Every rolling line with a trade stat id, helpful or not. */
    readonly rolls: readonly UniqueRoll[];
    /** Every line's trade stat id, rolling or not. */
    readonly statIds: readonly string[];
    /** Rolling lines with no trade stat id. */
    readonly unmatched: readonly string[];
}

export interface UniquesData {
    readonly slot: string;
    readonly itemType: string;
    readonly target: ResolvedTarget;
    readonly uniques: readonly UniqueInfo[];
}

function readUniqueInfo(value: unknown, path: string): UniqueInfo {
    const r: JsonRecord = record(value, path);
    return {
        name: string(r['name'], `${path}.name`),
        base: string(r['base'], `${path}.base`),
        tradeType: string(r['tradeType'], `${path}.tradeType`),
        variant: optNumber(r, 'variant', path) ?? null,
        variants: number(r['variants'], `${path}.variants`),
        scoreLow: number(r['scoreLow'], `${path}.scoreLow`),
        scoreMid: number(r['scoreMid'], `${path}.scoreMid`),
        scoreHigh: number(r['scoreHigh'], `${path}.scoreHigh`),
        change: number(r['change'], `${path}.change`),
        weights: luaArray(r['weights'], `${path}.weights`, (v: unknown, p: string): UniqueWeight => {
            const w: JsonRecord = record(v, p);
            return { id: string(w['id'], `${p}.id`), weight: number(w['weight'], `${p}.weight`), line: string(w['line'], `${p}.line`) };
        }),
        rolls: luaArray(r['rolls'], `${path}.rolls`, (v: unknown, p: string): UniqueRoll => {
            const w: JsonRecord = record(v, p);
            return {
                id: string(w['id'], `${p}.id`),
                line: string(w['line'], `${p}.line`),
                low: number(w['low'], `${p}.low`),
                high: number(w['high'], `${p}.high`),
            };
        }),
        statIds: luaArray(r['statIds'], `${path}.statIds`, string),
        unmatched: luaArray(r['unmatched'], `${path}.unmatched`, string),
    };
}

export function readUniques(value: unknown): UniquesData {
    const path: string = 'uniques';
    const r: JsonRecord = record(value, path);
    return {
        slot: string(r['slot'], `${path}.slot`),
        itemType: string(r['itemType'], `${path}.itemType`),
        target: readTarget(r['target'], `${path}.target`),
        uniques: luaArray(r['uniques'], `${path}.uniques`, readUniqueInfo),
    };
}

export function readTradeQueryProgress(value: unknown): TradeQueryProgress {
    const r: JsonRecord = record(value, 'progress');
    return { calcs: number(r['calcs'], 'progress.calcs'), seconds: number(r['seconds'], 'progress.seconds') };
}

export function readScoreItem(value: unknown): ScoreItemResult {
    const path: string = 'item';
    const r: JsonRecord = record(value, path);
    const index: number = number(r['index'], `${path}.index`);
    if (boolean(r['ok'], `${path}.ok`)) {
        return {
            index: index,
            ok: true,
            item: readItemInfo(r['item'], `${path}.item`),
            stats: readStatBlock(r['stats'], `${path}.stats`),
            unparsed: luaArray(r['unparsed'], `${path}.unparsed`, string),
            validForSlot: boolean(r['validForSlot'], `${path}.validForSlot`),
            offHandRemoved: boolean(r['offHandRemoved'], `${path}.offHandRemoved`),
        };
    }
    return { index: index, ok: false, error: readErrorInfo(r['error'], `${path}.error`) };
}

export function readScoreSummary(value: unknown): ScoreBatchSummary {
    const r: JsonRecord = record(value, 'score');
    return {
        count: number(r['count'], 'score.count'),
        failed: number(r['failed'], 'score.failed'),
        gcRuns: number(r['gcRuns'], 'score.gcRuns'),
        seconds: number(r['seconds'], 'score.seconds'),
        offHandRemoved: number(r['offHandRemoved'], 'score.offHandRemoved'),
    };
}

export function readPing(value: unknown): PingData {
    const r: JsonRecord = record(value, 'ping');
    return {
        pobVersion: string(r['pobVersion'], 'ping.pobVersion'),
        buildId: optString(r, 'buildId', 'ping'),
        gcEvery: number(r['gcEvery'], 'ping.gcEvery'),
        scoresSinceGc: number(r['scoresSinceGc'], 'ping.scoresSinceGc'),
        gcRuns: number(r['gcRuns'], 'ping.gcRuns'),
        luaHeapMb: number(r['luaHeapMb'], 'ping.luaHeapMb'),
    };
}
