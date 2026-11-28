// Runtime checks on what crosses IPC. Main checks every request from the renderer (the renderer shows web
// content, so main never trusts its input); the renderer checks the response envelope, each method's result,
// and the events.

import { array, boolean, isRecord, messageOf, number, oneOf, record, string, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import { parseBudgetText } from './budget.ts';
import { readOptionalItemView } from './item-view.ts';
import { readPickedUnique, readSlotEditorData, readSlotPlan, readSlotPlans } from './plan.ts';
import { readLimitPanel, readRunEvent, readRunHeader, readRunSnapshot, readUniqueList, readWeightPreview, RUN_PHASES } from './run.ts';
import type { RunPhase, RunRequest } from './run.ts';
import { POB_UPDATE_PHASES, SIGN_IN_STATUSES, UI_LOG_LEVELS } from './contract.ts';
import type {
    AppInfo,
    AppSettings,
    BuildEntry,
    BuildSettings,
    BuildsDirSource,
    BuildState,
    BuildsList,
    BuildSummary,
    EquippedInfo,
    InvokeRequest,
    InvokeResponse,
    IpcErrorCode,
    LogsView,
    MainEvent,
    MethodName,
    NoticeLevel,
    Params,
    PobUpdateState,
    RateInfo,
    RateSource,
    RateState,
    Result,
    SignInState,
    TargetOption,
    UiLogLine,
} from './contract.ts';
import {
    ELEMENTS,
    GEAR_SLOTS,
    LEVEL_FILTER_KINDS,
    LISTING_TYPES,
    MAX_CHARACTER_LEVEL,
    MAX_WEIGHT_FACTOR,
    SEARCH_DEPTHS,
    UNIQUE_MODES,
} from '@poe-upgrade-finder/vocab';
import type {
    Element,
    FloorSettings,
    GearSlot,
    LevelFilter,
    SlotPlan,
    UniqueChoice,
    WeightEdit,
    WeightEdits,
} from '@poe-upgrade-finder/vocab';

type Read<T> = (value: unknown, path: string) => T;

// Helpers ------------------------------------------------------------------------------------------------

/** A record with only the given keys (a stray key is a mistake or an attack, either way refused). */
function exact(value: unknown, path: string, keys: readonly string[]): JsonRecord {
    const r: JsonRecord = record(value, path);
    for (const key of Object.keys(r)) {
        if (!keys.includes(key)) {
            throw new ValidationError(`${path}.${key}: unexpected field`);
        }
    }
    return r;
}

function nullable<T>(read: Read<T>): Read<T | null> {
    return (value: unknown, path: string): T | null => (value === null ? null : read(value, path));
}

function finite(value: unknown, path: string): number {
    const n: number = number(value, path);
    if (!Number.isFinite(n)) {
        throw new ValidationError(`${path}: expected a finite number`);
    }
    return n;
}

function between(min: number, max: number): Read<number> {
    return (value: unknown, path: string): number => {
        const n: number = finite(value, path);
        if (n < min || n > max) {
            throw new ValidationError(`${path}: expected ${min} to ${max}, got ${n}`);
        }
        return n;
    };
}

function text(maxLength: number): Read<string> {
    return (value: unknown, path: string): string => {
        const s: string = string(value, path);
        if (s.length > maxLength) {
            throw new ValidationError(`${path}: longer than ${maxLength} characters`);
        }
        return s;
    };
}

function nonEmpty(maxLength: number): Read<string> {
    return (value: unknown, path: string): string => {
        const s: string = text(maxLength)(value, path);
        if (s.trim() === '') {
            throw new ValidationError(`${path}: empty`);
        }
        return s;
    };
}

/** A build id: a relative .xml path with forward slashes and no ".." (main still resolves it inside the folder). */
function buildId(value: unknown, path: string): string {
    const s: string = nonEmpty(1024)(value, path);
    if (
        !s.toLowerCase().endsWith('.xml') ||
        s.startsWith('/') ||
        s.includes('\\') ||
        /[\u0000-\u001f]/.test(s) ||
        /^[a-z]:/i.test(s) ||
        s.split('/').some((p: string) => p === '..' || p === '.' || p === '')
    ) {
        throw new ValidationError(`${path}: not a build id`);
    }
    return s;
}

/** A target id: saved, full, or skill:G.A[.P]. */
export function isTargetId(s: string): boolean {
    return s === 'saved' || s === 'full' || /^skill:\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(s);
}

function targetId(value: unknown, path: string): string {
    const s: string = string(value, path);
    if (!isTargetId(s)) {
        throw new ValidationError(`${path}: not a damage target (saved, full, skill:G.A[.P])`);
    }
    return s;
}

const slot: Read<(typeof GEAR_SLOTS)[number]> = (value: unknown, path: string) => oneOf(value, path, GEAR_SLOTS);

// Settings -----------------------------------------------------------------------------------------------

const percent: Read<number> = between(-100, 100);

function perElement(value: unknown, path: string): Partial<Record<Element, number>> {
    const r: JsonRecord = exact(value, path, ELEMENTS);
    const out: Partial<Record<Element, number>> = {};
    for (const el of ELEMENTS) {
        if (r[el] !== undefined) {
            out[el] = percent(r[el], `${path}.${el}`);
        }
    }
    return out;
}

export function readFloors(value: unknown, path: string): FloorSettings {
    const r: JsonRecord = exact(value, path, [
        'chaosResMin',
        'maxResMin',
        'elementalResCapped',
        'spellBlockMin',
        'attributesMet',
        'targets',
        'flagLifeLoss',
        'flagNetRegen',
    ]);
    const out: { -readonly [K in keyof FloorSettings]: FloorSettings[K] } = {};
    if (r['chaosResMin'] !== undefined) {
        out.chaosResMin = percent(r['chaosResMin'], `${path}.chaosResMin`);
    }
    if (r['spellBlockMin'] !== undefined) {
        out.spellBlockMin = between(0, 100)(r['spellBlockMin'], `${path}.spellBlockMin`);
    }
    if (r['maxResMin'] !== undefined) {
        out.maxResMin = perElement(r['maxResMin'], `${path}.maxResMin`);
    }
    for (const key of ['elementalResCapped', 'attributesMet', 'flagLifeLoss', 'flagNetRegen'] as const) {
        if (r[key] !== undefined) {
            out[key] = boolean(r[key], `${path}.${key}`);
        }
    }
    if (r['targets'] !== undefined) {
        const t: JsonRecord = exact(r['targets'], `${path}.targets`, ['chaosRes', 'maxRes', 'overcapMin']);
        const targets: { chaosRes?: number; maxRes?: Partial<Record<Element, number>>; overcapMin?: number } = {};
        if (t['chaosRes'] !== undefined) {
            targets.chaosRes = percent(t['chaosRes'], `${path}.targets.chaosRes`);
        }
        if (t['overcapMin'] !== undefined) {
            targets.overcapMin = between(0, 500)(t['overcapMin'], `${path}.targets.overcapMin`);
        }
        if (t['maxRes'] !== undefined) {
            targets.maxRes = perElement(t['maxRes'], `${path}.targets.maxRes`);
        }
        out.targets = targets;
    }
    return out;
}

export function readAppSettings(value: unknown, path: string): AppSettings {
    const r: JsonRecord = exact(value, path, ['league', 'listing', 'depth', 'buildsDir', 'debug']);
    return {
        league: nonEmpty(64)(r['league'], `${path}.league`).trim(),
        listing: oneOf(r['listing'], `${path}.listing`, LISTING_TYPES),
        depth: oneOf(r['depth'], `${path}.depth`, SEARCH_DEPTHS),
        buildsDir: nullable(nonEmpty(1024))(r['buildsDir'], `${path}.buildsDir`),
        debug: boolean(r['debug'], `${path}.debug`),
    };
}

/** One reader per build setting; a missing field the app added later reads as its old meaning. */
const BUILD_SETTING_READERS: { readonly [K in keyof BuildSettings]-?: Read<BuildSettings[K]> } = {
    floors: readFloors,
    blend: between(0, 1),
    minGainPct: between(0, 100),
    lastSlot: nullable(slot),
    lastBudget: nullable(text(32)),
    // Settings saved before the min price existed have no field: none.
    lastMinBudget: (value: unknown, path: string) => (value === undefined ? null : nullable(text(32))(value, path)),
    lastTarget: nullable(targetId),
    weightEdits: (value: unknown, path: string) => (value === undefined ? {} : readWeightEdits(value, path)),
    // Settings saved before slot plans existed have none.
    slotPlans: (value: unknown, path: string) => (value === undefined ? {} : readSlotPlans(value, path)),
    // Settings saved before the filter was a setting: up to the character's level, as it always was.
    levelFilter: (value: unknown, path: string) => (value === undefined ? { kind: 'character' } : readLevelFilter(value, path)),
    // Settings saved before unique searches (#113) have none: every slot searches rares.
    uniqueChoices: (value: unknown, path: string) => (value === undefined ? {} : readUniqueChoices(value, path)),
};

function readUniqueChoice(value: unknown, path: string): UniqueChoice {
    const r: JsonRecord = exact(value, path, ['mode', 'unique']);
    return { mode: oneOf(r['mode'], `${path}.mode`, UNIQUE_MODES), unique: nullable(readPickedUnique)(r['unique'], `${path}.unique`) };
}

function readUniqueChoices(value: unknown, path: string): Partial<Record<GearSlot, UniqueChoice>> {
    const r: JsonRecord = record(value, path);
    const out: Partial<Record<GearSlot, UniqueChoice>> = {};
    for (const [key, choice] of Object.entries(r)) {
        out[slot(key, `${path} key`)] = readUniqueChoice(choice, `${path}.${key}`);
    }
    return out;
}

const BUILD_SETTING_KEYS: readonly (keyof BuildSettings)[] = [
    'floors',
    'blend',
    'minGainPct',
    'lastSlot',
    'lastBudget',
    'lastMinBudget',
    'lastTarget',
    'weightEdits',
    'slotPlans',
    'levelFilter',
    'uniqueChoices',
];

/** Build settings over IPC: all or nothing. */
export function readBuildSettings(value: unknown, path: string): BuildSettings {
    const r: JsonRecord = exact(value, path, BUILD_SETTING_KEYS);
    const field = <T>(read: Read<T>, key: keyof BuildSettings): T => read(r[key], `${path}.${key}`);
    return {
        floors: field(BUILD_SETTING_READERS.floors, 'floors'),
        blend: field(BUILD_SETTING_READERS.blend, 'blend'),
        minGainPct: field(BUILD_SETTING_READERS.minGainPct, 'minGainPct'),
        lastSlot: field(BUILD_SETTING_READERS.lastSlot, 'lastSlot'),
        lastBudget: field(BUILD_SETTING_READERS.lastBudget, 'lastBudget'),
        lastMinBudget: field(BUILD_SETTING_READERS.lastMinBudget, 'lastMinBudget'),
        lastTarget: field(BUILD_SETTING_READERS.lastTarget, 'lastTarget'),
        weightEdits: field(BUILD_SETTING_READERS.weightEdits, 'weightEdits'),
        slotPlans: field(BUILD_SETTING_READERS.slotPlans, 'slotPlans'),
        levelFilter: field(BUILD_SETTING_READERS.levelFilter, 'levelFilter'),
        uniqueChoices: field(BUILD_SETTING_READERS.uniqueChoices, 'uniqueChoices'),
    };
}

/**
 * Build settings from the file on disk (issue #69): field by field, so one bad field falls back to its default
 * alone, and one bad slot plan or one slot's bad weight edits drop only that slot. An unknown field (from a newer
 * version) is dropped. Each drop is reported through `dropped`; the result is always valid. Throws only when the
 * value isn't a record at all.
 */
export function readStoredBuildSettings(
    value: unknown,
    path: string,
    defaults: BuildSettings,
    dropped: (problem: string) => void,
): BuildSettings {
    const r: JsonRecord = record(value, path);
    for (const key of Object.keys(r)) {
        if (!(BUILD_SETTING_KEYS as readonly string[]).includes(key)) {
            dropped(`${path}.${key}: not a setting this version knows`);
        }
    }
    const field = <K extends keyof BuildSettings>(read: Read<BuildSettings[K]>, key: K): BuildSettings[K] => {
        try {
            return read(r[key], `${path}.${key}`);
        } catch (error: unknown) {
            dropped(messageOf(error));
            return defaults[key];
        }
    };
    /** Per slot: each entry of the slot record is read on its own, with the field's all-or-nothing reader. */
    const perSlot = <K extends 'weightEdits' | 'slotPlans' | 'uniqueChoices'>(read: Read<BuildSettings[K]>, key: K): BuildSettings[K] => {
        const v: unknown = r[key];
        if (!isRecord(v)) {
            return field(read, key);
        }
        let out: BuildSettings[K] = read({}, `${path}.${key}`);
        for (const [slotKey, entry] of Object.entries(v)) {
            try {
                out = { ...out, ...read({ [slotKey]: entry }, `${path}.${key}`) };
            } catch (error: unknown) {
                dropped(messageOf(error));
            }
        }
        return out;
    };
    return {
        floors: field(BUILD_SETTING_READERS.floors, 'floors'),
        blend: field(BUILD_SETTING_READERS.blend, 'blend'),
        minGainPct: field(BUILD_SETTING_READERS.minGainPct, 'minGainPct'),
        lastSlot: field(BUILD_SETTING_READERS.lastSlot, 'lastSlot'),
        lastBudget: field(BUILD_SETTING_READERS.lastBudget, 'lastBudget'),
        lastMinBudget: field(BUILD_SETTING_READERS.lastMinBudget, 'lastMinBudget'),
        lastTarget: field(BUILD_SETTING_READERS.lastTarget, 'lastTarget'),
        // Files from before #111 hold absolute weights: the reader migrates what it can and reports the rest.
        weightEdits: perSlot((v: unknown, p: string) => (v === undefined ? {} : readStoredWeightEdits(v, p, dropped)), 'weightEdits'),
        slotPlans: perSlot(BUILD_SETTING_READERS.slotPlans, 'slotPlans'),
        levelFilter: field(BUILD_SETTING_READERS.levelFilter, 'levelFilter'),
        uniqueChoices: perSlot(BUILD_SETTING_READERS.uniqueChoices, 'uniqueChoices'),
    };
}

export function readLevelFilter(value: unknown, path: string): LevelFilter {
    const r: JsonRecord = record(value, path);
    const kind: LevelFilter['kind'] = oneOf(r['kind'], `${path}.kind`, LEVEL_FILTER_KINDS);
    if (kind !== 'max') {
        if (Object.keys(r).some((k: string) => k !== 'kind')) {
            throw new ValidationError(`${path}: only "max" takes a level`);
        }
        return { kind: kind };
    }
    const level: number = number(r['level'], `${path}.level`);
    if (!Number.isInteger(level) || level < 1 || level > MAX_CHARACTER_LEVEL) {
        throw new ValidationError(`${path}.level: expected a whole number from 1 to ${MAX_CHARACTER_LEVEL}`);
    }
    if (Object.keys(r).some((k: string) => k !== 'kind' && k !== 'level')) {
        throw new ValidationError(`${path}: unexpected field`);
    }
    return { kind: 'max', level: level };
}

/** Per slot, stat id → weight (0 = off); weights are finite and not negative. */
type SlotWeightEdits = Partial<Record<GearSlot, WeightEdits>>;

/** One stat's edit (vocab's weight-model): a positive factor, off, or both; never neither. */
function readWeightEdit(value: unknown, path: string): WeightEdit {
    const r: JsonRecord = exact(value, path, ['factor', 'off']);
    const factor: number | undefined = r['factor'] === undefined ? undefined : between(0, MAX_WEIGHT_FACTOR)(r['factor'], `${path}.factor`);
    if (factor === 0) {
        throw new ValidationError(`${path}.factor: must be above 0 (off is its own field)`);
    }
    if (r['off'] !== undefined && r['off'] !== true) {
        throw new ValidationError(`${path}.off: expected true or no field`);
    }
    const off: boolean = r['off'] === true;
    if (factor === undefined && !off) {
        throw new ValidationError(`${path}: an edit needs a factor or off`);
    }
    return { ...(factor === undefined ? {} : { factor: factor }), ...(off ? { off: true as const } : {}) };
}

function statKey(statId: string, path: string): string {
    if (statId.length > 80) {
        throw new ValidationError(`${path}: a stat id is too long`);
    }
    return statId;
}

/** The edits per slot over IPC: the current shape only. */
function readWeightEdits(value: unknown, path: string): SlotWeightEdits {
    const r: JsonRecord = record(value, path);
    const out: SlotWeightEdits = {};
    for (const [key, edits] of Object.entries(r)) {
        const s: GearSlot = slot(key, `${path} key`);
        const e: JsonRecord = record(edits, `${path}.${key}`);
        const map: Record<string, WeightEdit> = {};
        for (const [statId, w] of Object.entries(e)) {
            map[statKey(statId, `${path}.${key}`)] = readWeightEdit(w, `${path}.${key}.${statId}`);
        }
        out[s] = map;
    }
    return out;
}

/**
 * The edits per slot from a settings file, old ones included (#111). Before #111 an edit was PoB's absolute
 * weight with 0 for off: a 0 becomes { off }, and any other number is dropped with a note, since PoB's weight
 * under the target it was made with isn't recorded (Jarraxas, 27 Nov). A slot left with no edits is left out.
 */
function readStoredWeightEdits(value: unknown, path: string, dropped: (problem: string) => void): SlotWeightEdits {
    const r: JsonRecord = record(value, path);
    const out: SlotWeightEdits = {};
    for (const [key, edits] of Object.entries(r)) {
        const s: GearSlot = slot(key, `${path} key`);
        const e: JsonRecord = record(edits, `${path}.${key}`);
        const map: Record<string, WeightEdit> = {};
        for (const [statId, w] of Object.entries(e)) {
            const at: string = `${path}.${key}.${statId}`;
            const id: string = statKey(statId, `${path}.${key}`);
            if (typeof w !== 'number') {
                map[id] = readWeightEdit(w, at);
            } else if (w === 0) {
                map[id] = { off: true };
            } else {
                dropped(`${at}: an old absolute weight edit (${w}), dropped; set it again in the weight review`);
            }
        }
        if (Object.keys(map).length > 0) {
            out[s] = map;
        }
    }
    return out;
}

export function readRunRequest(value: unknown, path: string): RunRequest {
    const r: JsonRecord = exact(value, path, ['buildId', 'slots', 'budget', 'minBudget', 'target', 'depth', 'listing']);
    const slots: readonly SlotPlan[] = array(r['slots'], `${path}.slots`, readSlotPlan);
    // v0.2 searches one slot per run; v0.4's batch lifts this without changing the shape.
    if (slots.length !== 1) {
        throw new ValidationError(`${path}.slots: expected exactly one slot plan, got ${slots.length}`);
    }
    const minBudget: string = r['minBudget'] === undefined ? '' : text(32)(r['minBudget'], `${path}.minBudget`).trim();
    if (minBudget !== '' && parseBudgetText(minBudget) === undefined) {
        throw new ValidationError(`${path}.minBudget: not a price (100c or 1.5d)`);
    }
    const budget: string = nonEmpty(32)(r['budget'], `${path}.budget`);
    if (parseBudgetText(budget) === undefined) {
        throw new ValidationError(`${path}.budget: not a budget (300c or 1.5d)`);
    }
    return {
        buildId: buildId(r['buildId'], `${path}.buildId`),
        slots: slots,
        budget: budget,
        minBudget: minBudget,
        target: targetId(r['target'], `${path}.target`),
        depth: oneOf(r['depth'], `${path}.depth`, SEARCH_DEPTHS),
        listing: oneOf(r['listing'], `${path}.listing`, LISTING_TYPES),
    };
}

// Params -------------------------------------------------------------------------------------------------

type ParamCheck<M extends MethodName> = Read<Params<M>>;

function noParams(value: unknown, path: string): Readonly<Record<string, never>> {
    exact(value, path, []);
    return {};
}

export const METHOD_PARAMS: { readonly [M in MethodName]: ParamCheck<M> } = {
    'app.info': noParams,
    'app.pobLicense': noParams,
    'pob.status': noParams,
    'pob.check': noParams,
    'pob.update': noParams,
    'pob.rollback': noParams,
    'app.removeFromPc': noParams,
    'settings.get': noParams,
    'settings.save': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['settings']);
        return { settings: readAppSettings(r['settings'], `${path}.settings`) };
    },
    'settings.pickBuildsDir': noParams,
    'builds.list': noParams,
    'build.select': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['buildId', 'target']);
        return { buildId: buildId(r['buildId'], `${path}.buildId`), target: nullable(targetId)(r['target'] ?? null, `${path}.target`) };
    },
    'build.settings.get': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['buildId']);
        return { buildId: buildId(r['buildId'], `${path}.buildId`) };
    },
    'build.settings.save': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['buildId', 'settings']);
        return { buildId: buildId(r['buildId'], `${path}.buildId`), settings: readBuildSettings(r['settings'], `${path}.settings`) };
    },
    'weights.preview': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['buildId', 'slot', 'target', 'plan']);
        const s: GearSlot = slot(r['slot'], `${path}.slot`);
        const plan: SlotPlan | null = r['plan'] === undefined ? null : nullable(readSlotPlan)(r['plan'], `${path}.plan`);
        if (plan !== null && plan.slot !== s) {
            throw new ValidationError(`${path}.plan: the plan is for ${plan.slot}, not ${s}`);
        }
        return { buildId: buildId(r['buildId'], `${path}.buildId`), slot: s, target: targetId(r['target'], `${path}.target`), plan: plan };
    },
    'uniques.list': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['buildId', 'slot', 'target', 'itemType']);
        return {
            buildId: buildId(r['buildId'], `${path}.buildId`),
            slot: slot(r['slot'], `${path}.slot`),
            target: targetId(r['target'], `${path}.target`),
            itemType: nonEmpty(60)(r['itemType'], `${path}.itemType`),
        };
    },
    'slot.data': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['slot', 'itemType', 'base']);
        return {
            slot: slot(r['slot'], `${path}.slot`),
            itemType: nonEmpty(60)(r['itemType'], `${path}.itemType`),
            base: nullable(nonEmpty(120))(r['base'], `${path}.base`),
        };
    },
    'signin.status': noParams,
    'signin.check': noParams,
    'signin.open': noParams,
    'signin.signOut': noParams,
    'rate.status': noParams,
    'rate.get': noParams,
    'rate.refresh': noParams,
    'rate.setManual': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['chaosPerDivine']);
        const n: number = between(1, 100_000)(r['chaosPerDivine'], `${path}.chaosPerDivine`);
        return { chaosPerDivine: n };
    },
    'rate.useGgg': noParams,
    'run.start': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['request']);
        return { request: readRunRequest(r['request'], `${path}.request`) };
    },
    'run.pause': noParams,
    'run.resume': noParams,
    'run.cancel': noParams,
    'run.deepen': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['runId']);
        return { runId: nonEmpty(200)(r['runId'], `${path}.runId`) };
    },
    'run.current': noParams,
    'run.limits': noParams,
    'logs.recent': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['minLevel', 'area', 'runId', 'limit']);
        return {
            minLevel: oneOf(r['minLevel'], `${path}.minLevel`, UI_LOG_LEVELS),
            area: nullable(nonEmpty(100))(r['area'], `${path}.area`),
            runId: nullable(nonEmpty(200))(r['runId'], `${path}.runId`),
            limit: between(1, 2000)(r['limit'], `${path}.limit`),
        };
    },
    'logs.export': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['runId']);
        return { runId: nullable(nonEmpty(200))(r['runId'], `${path}.runId`) };
    },
    'link.open': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['runId', 'itemId']);
        return { runId: nonEmpty(200)(r['runId'], `${path}.runId`), itemId: nonEmpty(200)(r['itemId'], `${path}.itemId`) };
    },
};

export function isMethodName(value: string): value is MethodName {
    return Object.hasOwn(METHOD_PARAMS, value);
}

export function parseInvokeRequest(value: unknown): InvokeRequest {
    const r: JsonRecord = record(value, 'request');
    const method: string = string(r['method'], 'request.method');
    if (!isMethodName(method)) {
        throw new ValidationError(`request.method: unknown method ${method}`);
    }
    return { method: method, params: METHOD_PARAMS[method](r['params'] ?? {}, 'request.params') };
}

// Results ------------------------------------------------------------------------------------------------

function appInfo(value: unknown, path: string): AppInfo {
    const r: JsonRecord = record(value, path);
    return {
        appVersion: string(r['appVersion'], `${path}.appVersion`),
        electron: string(r['electron'], `${path}.electron`),
        chromium: string(r['chromium'], `${path}.chromium`),
        node: string(r['node'], `${path}.node`),
        pobVersion: optString(r['pobVersion'], `${path}.pobVersion`),
        canRemove: boolean(r['canRemove'], `${path}.canRemove`),
    };
}

const optString: Read<string | null> = nullable(string);

export function readPobUpdateState(value: unknown, path: string): PobUpdateState {
    const r: JsonRecord = exact(value, path, ['live', 'latest', 'phase', 'step', 'message', 'previous', 'fixed']);
    return {
        live: optString(r['live'], `${path}.live`),
        latest: optString(r['latest'], `${path}.latest`),
        phase: oneOf(r['phase'], `${path}.phase`, POB_UPDATE_PHASES),
        step: optString(r['step'], `${path}.step`),
        message: optString(r['message'], `${path}.message`),
        previous: optString(r['previous'], `${path}.previous`),
        fixed: boolean(r['fixed'], `${path}.fixed`),
    };
}
const optNumber: Read<number | null> = nullable(finite);

function buildEntry(value: unknown, path: string): BuildEntry {
    const r: JsonRecord = record(value, path);
    return {
        id: string(r['id'], `${path}.id`),
        name: string(r['name'], `${path}.name`),
        folder: string(r['folder'], `${path}.folder`),
        className: optString(r['className'], `${path}.className`),
        ascendClassName: optString(r['ascendClassName'], `${path}.ascendClassName`),
        level: optNumber(r['level'], `${path}.level`),
        modifiedMs: finite(r['modifiedMs'], `${path}.modifiedMs`),
    };
}

const DIR_SOURCES: readonly BuildsDirSource[] = ['override', 'pob-settings', 'pob-default'];

export function readBuildsList(value: unknown, path: string): BuildsList {
    const r: JsonRecord = record(value, path);
    return {
        dir: optString(r['dir'], `${path}.dir`),
        source: oneOf(r['source'], `${path}.source`, DIR_SOURCES),
        builds: array(r['builds'], `${path}.builds`, buildEntry),
        error: optString(r['error'], `${path}.error`),
    };
}

function targetOption(value: unknown, path: string): TargetOption {
    const r: JsonRecord = record(value, path);
    return { id: string(r['id'], `${path}.id`), label: string(r['label'], `${path}.label`) };
}

export function readEquippedInfo(value: unknown, path: string): EquippedInfo {
    const r: JsonRecord = record(value, path);
    return {
        slot: string(r['slot'], `${path}.slot`),
        name: string(r['name'], `${path}.name`),
        base: string(r['base'], `${path}.base`),
        rarity: string(r['rarity'], `${path}.rarity`),
        // Gear cached before the field existed has none.
        itemType: r['itemType'] === undefined ? null : optString(r['itemType'], `${path}.itemType`),
        view: readOptionalItemView(r['view'], `${path}.view`),
    };
}

export function readBuildSummary(value: unknown, path: string): BuildSummary {
    const r: JsonRecord = record(value, path);
    return {
        buildId: string(r['buildId'], `${path}.buildId`),
        pobVersion: string(r['pobVersion'], `${path}.pobVersion`),
        className: optString(r['className'], `${path}.className`),
        ascendClassName: optString(r['ascendClassName'], `${path}.ascendClassName`),
        level: optNumber(r['level'], `${path}.level`),
        targetId: string(r['targetId'], `${path}.targetId`),
        targetLabel: string(r['targetLabel'], `${path}.targetLabel`),
        targets: array(r['targets'], `${path}.targets`, targetOption),
        damage: finite(r['damage'], `${path}.damage`),
        ehp: optNumber(r['ehp'], `${path}.ehp`),
        life: optNumber(r['life'], `${path}.life`),
        equipped: array(r['equipped'], `${path}.equipped`, readEquippedInfo),
        warnings: array(r['warnings'], `${path}.warnings`, string),
        fileModifiedMs: finite(r['fileModifiedMs'], `${path}.fileModifiedMs`),
    };
}

function buildState(value: unknown, path: string): BuildState {
    const r: JsonRecord = record(value, path);
    const kind: BuildState['kind'] = oneOf(r['kind'], `${path}.kind`, ['none', 'loading', 'ready', 'error'] as const);
    switch (kind) {
        case 'none':
            return { kind: 'none' };
        case 'loading':
            return {
                kind: 'loading',
                buildId: string(r['buildId'], `${path}.buildId`),
                equipped:
                    r['equipped'] === undefined || r['equipped'] === null
                        ? null
                        : array(r['equipped'], `${path}.equipped`, readEquippedInfo),
                summary: r['summary'] === undefined || r['summary'] === null ? null : readBuildSummary(r['summary'], `${path}.summary`),
            };
        case 'ready':
            return { kind: 'ready', summary: readBuildSummary(r['summary'], `${path}.summary`) };
        case 'error':
            return { kind: 'error', buildId: string(r['buildId'], `${path}.buildId`), message: string(r['message'], `${path}.message`) };
    }
}

export function readSignInState(value: unknown, path: string): SignInState {
    const r: JsonRecord = record(value, path);
    return {
        status: oneOf(r['status'], `${path}.status`, SIGN_IN_STATUSES),
        message: optString(r['message'], `${path}.message`),
        checkedAtMs: optNumber(r['checkedAtMs'], `${path}.checkedAtMs`),
    };
}

const RATE_SOURCES: readonly RateSource[] = ['ggg', 'manual'];

function rateInfo(value: unknown, path: string): RateInfo {
    const r: JsonRecord = record(value, path);
    return {
        chaosPerDivine: finite(r['chaosPerDivine'], `${path}.chaosPerDivine`),
        source: oneOf(r['source'], `${path}.source`, RATE_SOURCES),
        hourMs: optNumber(r['hourMs'], `${path}.hourMs`),
        atMs: finite(r['atMs'], `${path}.atMs`),
    };
}

export function readRateState(value: unknown, path: string): RateState {
    const r: JsonRecord = record(value, path);
    return {
        league: string(r['league'], `${path}.league`),
        rate: nullable(rateInfo)(r['rate'], `${path}.rate`),
        busy: boolean(r['busy'], `${path}.busy`),
        error: optString(r['error'], `${path}.error`),
        refreshBlockedUntilMs: optNumber(r['refreshBlockedUntilMs'], `${path}.refreshBlockedUntilMs`),
    };
}

function runPhase(value: unknown, path: string): RunPhase {
    return oneOf(value, path, RUN_PHASES);
}

type ResultCheck<M extends MethodName> = Read<Result<M>>;

/** The renderer's checks on each method's result. */
export const METHOD_RESULTS: { readonly [M in MethodName]: ResultCheck<M> } = {
    'app.info': appInfo,
    'pob.status': readPobUpdateState,
    'pob.check': readPobUpdateState,
    'pob.update': readPobUpdateState,
    'pob.rollback': readPobUpdateState,
    'app.pobLicense': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['text']);
        return { text: optString(r['text'], `${path}.text`) };
    },
    'app.removeFromPc': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['removing', 'message']);
        return { removing: boolean(r['removing'], `${path}.removing`), message: optString(r['message'], `${path}.message`) };
    },
    'settings.get': readAppSettings,
    'settings.save': readAppSettings,
    'settings.pickBuildsDir': optString,
    'builds.list': readBuildsList,
    'build.select': readBuildSummary,
    'build.settings.get': readBuildSettings,
    'build.settings.save': readBuildSettings,
    'weights.preview': readWeightPreview,
    'uniques.list': readUniqueList,
    'slot.data': readSlotEditorData,
    'signin.status': readSignInState,
    'signin.check': readSignInState,
    'signin.open': readSignInState,
    'signin.signOut': readSignInState,
    'rate.status': readRateState,
    'rate.get': readRateState,
    'rate.refresh': readRateState,
    'rate.setManual': readRateState,
    'rate.useGgg': readRateState,
    'run.start': readRunHeader,
    'run.pause': runPhase,
    'run.resume': runPhase,
    'run.cancel': runPhase,
    'run.deepen': readRunHeader,
    'run.current': nullable(readRunSnapshot),
    'run.limits': readLimitPanel,
    'logs.recent': readLogsView,
    'logs.export': (value: unknown, path: string) => {
        const r: JsonRecord = exact(value, path, ['saved', 'file']);
        return { saved: boolean(r['saved'], `${path}.saved`), file: optString(r['file'], `${path}.file`) };
    },
    'link.open': (value: unknown, path: string) => {
        const r: JsonRecord = record(value, path);
        return { opened: boolean(r['opened'], `${path}.opened`), message: optString(r['message'], `${path}.message`) };
    },
};

function logLine(value: unknown, path: string): UiLogLine {
    const r: JsonRecord = exact(value, path, ['t', 'level', 'area', 'runId', 'msg', 'data']);
    return {
        t: finite(r['t'], `${path}.t`),
        level: oneOf(r['level'], `${path}.level`, UI_LOG_LEVELS),
        area: string(r['area'], `${path}.area`),
        runId: optString(r['runId'], `${path}.runId`),
        msg: string(r['msg'], `${path}.msg`),
        data: optString(r['data'], `${path}.data`),
    };
}

export function readLogsView(value: unknown, path: string): LogsView {
    const r: JsonRecord = exact(value, path, ['file', 'lines', 'areas']);
    return {
        file: string(r['file'], `${path}.file`),
        lines: array(r['lines'], `${path}.lines`, logLine),
        areas: array(r['areas'], `${path}.areas`, string),
    };
}

const ERROR_CODES: readonly IpcErrorCode[] = ['bad-request', 'failed', 'not-allowed'];

/** The renderer's check on the envelope; the result is then checked by METHOD_RESULTS. */
export function parseInvokeResponse(value: unknown): InvokeResponse {
    const r: JsonRecord = record(value, 'response');
    if (r['ok'] === true) {
        return { ok: true, result: r['result'] };
    }
    const e: JsonRecord = record(r['error'], 'response.error');
    return {
        ok: false,
        error: { code: oneOf(e['code'], 'response.error.code', ERROR_CODES), message: string(e['message'], 'response.error.message') },
    };
}

// Events -------------------------------------------------------------------------------------------------

const NOTICE_LEVELS: readonly NoticeLevel[] = ['info', 'warn', 'error'];

/** Undefined for an unknown kind (an older renderer ignores newer events); throws on a malformed known one. */
export function parseMainEvent(value: unknown): MainEvent | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    switch (value['kind']) {
        case 'notice':
            return {
                kind: 'notice',
                level: oneOf(value['level'], 'event.level', NOTICE_LEVELS),
                message: string(value['message'], 'event.message'),
            };
        case 'builds-changed':
            return { kind: 'builds-changed', list: readBuildsList(value['list'], 'event.list') };
        case 'build-state':
            return { kind: 'build-state', state: buildState(value['state'], 'event.state') };
        case 'signin-state':
            return { kind: 'signin-state', state: readSignInState(value['state'], 'event.state') };
        case 'rate-state':
            return { kind: 'rate-state', state: readRateState(value['state'], 'event.state') };
        case 'limits':
            return { kind: 'limits', panel: readLimitPanel(value['panel'], 'event.panel') };
        case 'pob-state':
            return { kind: 'pob-state', state: readPobUpdateState(value['state'], 'event.state') };
        default:
            return readRunEvent(value);
    }
}
