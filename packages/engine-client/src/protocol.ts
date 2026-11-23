// Types for the engine protocol (engine/README.md, "The dispatcher") and runtime validation of every
// message that comes in. Non-finite numbers arrive as strings and are decoded to JS numbers here.

import { array, boolean, isRecord, number, oneOf, optional, ProtocolError, record, string } from './check.ts';
import type { JsonRecord } from './check.ts';
import { isEngineNumber, isEngineValue, toNumber } from './values.ts';
import { messageOf } from '@poe-upgrade-finder/validate';

// Requests ----------------------------------------------------------------------------------------------

/** The rare gear slots v1 searches. The engine accepts any PoB item slot; the app only uses these. */
export type GearSlot = 'Helmet' | 'Body Armour' | 'Gloves' | 'Boots' | 'Amulet' | 'Ring 1' | 'Ring 2' | 'Belt' | 'Weapon 1' | 'Weapon 2';

export const GEAR_SLOTS: readonly GearSlot[] = [
    'Helmet',
    'Body Armour',
    'Gloves',
    'Boots',
    'Amulet',
    'Ring 1',
    'Ring 2',
    'Belt',
    'Weapon 1',
    'Weapon 2',
];

export function isGearSlot(value: string): value is GearSlot {
    return GEAR_SLOTS.some((s: GearSlot) => s === value);
}

/** A damage target as requested. Indices are 1-based, as in PoB. */
export type TargetRequest =
    | { readonly kind: 'saved' }
    | { readonly kind: 'fullDps' }
    | { readonly kind: 'skill'; readonly group: number; readonly activeSkill: number; readonly part?: number };

export type CommandName = 'ping' | 'loadBuild' | 'stats' | 'strip' | 'tradeQuery' | 'score' | 'baseTypes' | 'slotData' | 'shutdown';

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
        warnings: array(m['warnings'], 'message.warnings', readWarning),
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

export type PobTone = 'plain' | 'augmented' | 'unmet' | 'fire' | 'cold' | 'lightning' | 'chaos' | 'label';
const POB_TONES: readonly PobTone[] = ['plain', 'augmented', 'unmet', 'fire', 'cold', 'lightning', 'chaos', 'label'];
export type PobModKind = 'enchant' | 'implicit' | 'explicit' | 'crafted' | 'fractured' | 'scourge' | 'crucible';
const POB_MOD_KINDS: readonly PobModKind[] = ['enchant', 'implicit', 'explicit', 'crafted', 'fractured', 'scourge', 'crucible'];
export type PobRarity = 'normal' | 'magic' | 'rare' | 'unique' | 'other';
const POB_RARITIES: readonly PobRarity[] = ['normal', 'magic', 'rare', 'unique', 'other'];
export type PobInfluence = 'shaper' | 'elder' | 'crusader' | 'redeemer' | 'hunter' | 'warlord' | 'searing' | 'tangled';
const POB_INFLUENCES: readonly PobInfluence[] = ['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord', 'searing', 'tangled'];

export interface PobViewPart {
    readonly text: string;
    readonly tone: PobTone;
}

/** An equipped item's tooltip groups, as PoB's own tooltip has them. The app adds the image. */
export interface PobItemView {
    readonly rarity: PobRarity;
    readonly name: string;
    readonly typeLine: string;
    /** The base type without PoB's "(...)" suffixes: the key for the item's art. */
    readonly baseName: string;
    readonly influences: readonly PobInfluence[];
    readonly properties: readonly (readonly PobViewPart[])[];
    readonly requirements: readonly PobViewPart[];
    readonly sockets: string;
    readonly itemLevel: number | null;
    readonly enchants: readonly { readonly text: string; readonly kind: PobModKind }[];
    readonly implicits: readonly { readonly text: string; readonly kind: PobModKind }[];
    readonly explicits: readonly { readonly text: string; readonly kind: PobModKind }[];
    readonly corrupted: boolean;
    readonly mirrored: boolean;
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

export interface StripData extends StatsData {
    readonly slot: string;
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
      }
    | { readonly index: number; readonly ok: false; readonly error: EngineErrorInfo };

export interface ScoreBatchSummary {
    readonly count: number;
    readonly failed: number;
    readonly gcRuns: number;
    readonly seconds: number;
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
        skillDps: optional(r['skillDps'], `${path}.skillDps`, (v: unknown, p: string) => array(v, p, readSkillDps)),
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

function readViewPart(value: unknown, path: string): PobViewPart {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), tone: oneOf(r['tone'], `${path}.tone`, POB_TONES) };
}

function readViewMod(value: unknown, path: string): { readonly text: string; readonly kind: PobModKind } {
    const r: JsonRecord = record(value, path);
    return { text: string(r['text'], `${path}.text`), kind: oneOf(r['kind'], `${path}.kind`, POB_MOD_KINDS) };
}

/** Lua sends an empty table as {}: an empty array may arrive as an empty object. */
function list<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): readonly T[] {
    if (isRecord(value) && Object.keys(value).length === 0) {
        return [];
    }
    return array(value, path, read);
}

export function readPobItemView(value: unknown, path: string): PobItemView {
    const r: JsonRecord = record(value, path);
    const ilvl: unknown = r['itemLevel'];
    return {
        rarity: oneOf(r['rarity'], `${path}.rarity`, POB_RARITIES),
        name: string(r['name'], `${path}.name`),
        typeLine: string(r['typeLine'], `${path}.typeLine`),
        baseName: string(r['baseName'], `${path}.baseName`),
        influences: list(r['influences'], `${path}.influences`, (v: unknown, p: string) => oneOf(v, p, POB_INFLUENCES)),
        properties: list(r['properties'], `${path}.properties`, (v: unknown, p: string) => list(v, p, readViewPart)),
        requirements: list(r['requirements'], `${path}.requirements`, readViewPart),
        sockets: string(r['sockets'], `${path}.sockets`),
        itemLevel: typeof ilvl === 'number' && Number.isFinite(ilvl) ? ilvl : null,
        enchants: list(r['enchants'], `${path}.enchants`, readViewMod),
        implicits: list(r['implicits'], `${path}.implicits`, readViewMod),
        explicits: list(r['explicits'], `${path}.explicits`, readViewMod),
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
        parts: array(r['parts'], `${path}.parts`, string),
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
        activeSkills: array(r['activeSkills'], `${path}.activeSkills`, readActiveSkill),
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
        skills: array(r['skills'], `${path}.skills`, readSocketGroup),
        target: readTarget(r['target'], `${path}.target`),
        baseline: readStatBlock(r['baseline'], `${path}.baseline`),
        equipped: array(r['equipped'], `${path}.equipped`, readEquipped),
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
    };
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
    return { type: string(r['type'], `${path}.type`), filters: array(r['filters'], `${path}.filters`, readPobFilter) };
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
        statWeights: array(r['statWeights'], `${path}.statWeights`, (v: unknown, p: string) => {
            const w: JsonRecord = record(v, p);
            return { stat: string(w['stat'], `${p}.stat`), weight: number(w['weight'], `${p}.weight`) };
        }),
        affixQuality: optNumber(r, 'affixQuality', path),
        baseStatValue: number(r['baseStatValue'], `${path}.baseStatValue`),
        weights: array(r['weights'], `${path}.weights`, readModWeight),
        query: { stats: array(query['stats'], `${path}.query.stats`, readPobGroup), raw: query },
        queryError: optString(r, 'queryError', path),
        calcs: number(r['calcs'], `${path}.calcs`),
        seconds: number(r['seconds'], `${path}.seconds`),
        log: array(r['log'], `${path}.log`, string),
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
            unparsed: array(r['unparsed'], `${path}.unparsed`, string),
            validForSlot: boolean(r['validForSlot'], `${path}.validForSlot`),
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
