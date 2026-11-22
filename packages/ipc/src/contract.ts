// The IPC contract between the main process and the renderer (PLAN.md, Architecture: the UI never touches
// the network or PoB; it asks the main process). Pure types and constants, no Node or DOM, so main, the
// preload and the renderer all share it.
//
// Requests go over one invoke channel as { method, params }; main checks every request at runtime
// (checks.ts) before a handler sees it, and answers with an envelope, never a thrown error, so the
// renderer gets a typed error instead of Electron's rewritten exception text. Events from main go over one
// event channel as a MainEvent union.
//
// Some types mirror packages/core and engine-client (slots, depth, floors). They are repeated here because
// this package must stay free of Node code (the renderer bundles it); a test in apps/desktop checks they match.

import type { LimitPanel, RunEventUi, RunHeader, RunPhase, RunRequest, RunSnapshot, WeightPreview } from './run.ts';
import type { ItemView } from './item-view.ts';

export const INVOKE_CHANNEL: string = 'uf:invoke';
export const EVENT_CHANNEL: string = 'uf:event';

// Shared vocabulary ----------------------------------------------------------------------------------------

export type GearSlot = 'Helmet' | 'Body Armour' | 'Gloves' | 'Boots' | 'Amulet' | 'Ring 1' | 'Ring 2' | 'Belt' | 'Weapon 1' | 'Weapon 2';
export const GEAR_SLOTS: readonly GearSlot[] = ['Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Weapon 1', 'Weapon 2'];

export type SearchDepth = 'thorough' | 'normal' | 'quick';
export const SEARCH_DEPTHS: readonly SearchDepth[] = ['thorough', 'normal', 'quick'];

/** Instant buyout only, or whisper listings too (D6). */
export type ListingType = 'securable' | 'online';
export const LISTING_TYPES: readonly ListingType[] = ['securable', 'online'];

export type Element = 'Fire' | 'Cold' | 'Lightning';
export const ELEMENTS: readonly Element[] = ['Fire', 'Cold', 'Lightning'];

/** Per build. The same shape as core's FloorSettings: omitted entries are off. */
export interface FloorSettings {
    readonly chaosResMin?: number;
    readonly maxResMin?: Readonly<Partial<Record<Element, number>>>;
    readonly elementalResCapped?: boolean;
    readonly spellBlockMin?: number;
    readonly attributesMet?: boolean;
    readonly targets?: {
        readonly chaosRes?: number;
        readonly maxRes?: Readonly<Partial<Record<Element, number>>>;
        readonly overcapMin?: number;
    };
    readonly flagLifeLoss?: boolean;
    readonly flagNetRegen?: boolean;
}

// Settings (PLAN.md, Data, settings & storage) -------------------------------------------------------------

/** settings.json. */
export interface AppSettings {
    readonly league: string;
    readonly listing: ListingType;
    readonly depth: SearchDepth;
    /** Overrides the PoB Builds folder; null: PoB's own setting. */
    readonly buildsDir: string | null;
    readonly debug: boolean;
}

/** characters/<build>.json. */
export interface BuildSettings {
    readonly floors: FloorSettings;
    /** DPS share of the gain, 0 to 1. */
    readonly blend: number;
    readonly minGainPct: number;
    readonly lastSlot: GearSlot | null;
    /** As typed: "300", "300c" or "1.5d". */
    readonly lastBudget: string | null;
    /** The min price as typed; null for none (search from 1c). */
    readonly lastMinBudget: string | null;
    /** A target id (TargetOption.id). */
    readonly lastTarget: string | null;
    /** The weight review per slot: stat id → weight, 0 for off (PLAN.md, "Review PoB's weights before searching"). */
    readonly weightEdits: Readonly<Partial<Record<GearSlot, Readonly<Record<string, number>>>>>;
}

// Builds ---------------------------------------------------------------------------------------------------

export interface BuildEntry {
    /** The save's path under the Builds folder, with forward slashes. */
    readonly id: string;
    readonly name: string;
    /** The sub-folder ("" at the top). */
    readonly folder: string;
    readonly className: string | null;
    readonly ascendClassName: string | null;
    readonly level: number | null;
    readonly modifiedMs: number;
}

export type BuildsDirSource = 'override' | 'pob-settings' | 'pob-default';

export interface BuildsList {
    readonly dir: string | null;
    readonly source: BuildsDirSource;
    readonly builds: readonly BuildEntry[];
    /** Set when the folder can't be read. */
    readonly error: string | null;
}

/** A damage target: "saved", "full", or "skill:<group>.<skill>[.<part>]" (PoB's 1-based indices). */
export interface TargetOption {
    readonly id: string;
    readonly label: string;
}

export interface EquippedInfo {
    readonly slot: string;
    readonly name: string;
    readonly base: string;
    readonly rarity: string;
    /** The tooltip and image for the gear layout; null when PoB couldn't describe the item. */
    readonly view: ItemView | null;
}

/** The build loaded in PoB, with the chosen damage target. */
export interface BuildSummary {
    readonly buildId: string;
    readonly pobVersion: string;
    readonly className: string | null;
    readonly ascendClassName: string | null;
    readonly level: number | null;
    /** The target as requested. */
    readonly targetId: string;
    /** What it resolved to ("Righteous Fire", "Full DPS"). */
    readonly targetLabel: string;
    readonly targets: readonly TargetOption[];
    readonly damage: number;
    readonly ehp: number | null;
    readonly life: number | null;
    readonly equipped: readonly EquippedInfo[];
    readonly warnings: readonly string[];
    /** The save's modified time when it was loaded (results from an older save get flagged). */
    readonly fileModifiedMs: number;
}

export type BuildState =
    | { readonly kind: 'none' }
    /** equipped: the last known gear for this build (cache.sqlite), shown while PoB loads; null when none. */
    | { readonly kind: 'loading'; readonly buildId: string; readonly equipped: readonly EquippedInfo[] | null }
    | { readonly kind: 'ready'; readonly summary: BuildSummary }
    | { readonly kind: 'error'; readonly buildId: string; readonly message: string };

// Sign-in (D10) and the divine rate (V21) -----------------------------------------------------------------

/** From a trade call's rate-limit rules (Account present), never from the cookie (V15). */
export type SignInStatus = 'unknown' | 'checking' | 'signed-in' | 'signed-out' | 'cloudflare' | 'window-open' | 'error';
export const SIGN_IN_STATUSES: readonly SignInStatus[] = ['unknown', 'checking', 'signed-in', 'signed-out', 'cloudflare', 'window-open', 'error'];

export interface SignInState {
    readonly status: SignInStatus;
    /** For 'error': what went wrong (e.g. an unknown league). */
    readonly message: string | null;
    readonly checkedAtMs: number | null;
}

export type RateSource = 'ggg' | 'manual';

export interface RateInfo {
    readonly chaosPerDivine: number;
    readonly source: RateSource;
    /** The GGG digest hour's start (ms), for a GGG rate. */
    readonly hourMs: number | null;
    /** When it was fetched or typed in. */
    readonly atMs: number;
}

export interface RateState {
    readonly league: string;
    /** null: unknown, the user types it in (only chaos-priced listings are searched meanwhile). */
    readonly rate: RateInfo | null;
    readonly busy: boolean;
    readonly error: string | null;
    /** Refresh is blocked until then (30 s between presses). */
    readonly refreshBlockedUntilMs: number | null;
}

// Methods --------------------------------------------------------------------------------------------------

export interface AppInfo {
    readonly appVersion: string;
    readonly electron: string;
    readonly chromium: string;
    readonly node: string;
    /** The PoB copy the engine runs (its manifest's version), or null when none is found. */
    readonly pobVersion: string | null;
    /** True when started by the launcher exe, so Remove from this PC can work. */
    readonly canRemove: boolean;
}

/** Updating the engine's PoB copy (PLAN.md, "Updating PoB in the app"). */
export type PobUpdatePhase = 'idle' | 'checking' | 'updating' | 'failed';
export const POB_UPDATE_PHASES: readonly PobUpdatePhase[] = ['idle', 'checking', 'updating', 'failed'];

export interface PobUpdateState {
    /** The PoB version the engine runs, or null when no copy is found. */
    readonly live: string | null;
    /** The latest release (master's manifest), or null until checked. */
    readonly latest: string | null;
    readonly phase: PobUpdatePhase;
    /** What an update is doing now ("Downloading 12 of 78 files"), or null. */
    readonly step: string | null;
    /** Why the last check or update failed, or what it did; null when there's nothing to say. */
    readonly message: string | null;
    /** The version a rollback goes back to, or null. */
    readonly previous: string | null;
    /** True when the PoB copy was given on the command line (dev): no updates. */
    readonly fixed: boolean;
}

type NoParams = Readonly<Record<string, never>>;

/** Every method: its params and its result. A new method goes here, in checks.ts (params and result) and in main's handler table. */
export type UiLogLevel = 'debug' | 'info' | 'warn' | 'error';
export const UI_LOG_LEVELS: readonly UiLogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface UiLogLine {
    readonly t: number;
    readonly level: UiLogLevel;
    readonly area: string;
    readonly runId: string | null;
    readonly msg: string;
    /** The line's data as JSON, cut to a few thousand characters; null when it has none. */
    readonly data: string | null;
}

export interface LogsView {
    /** The file read (today's). */
    readonly file: string;
    /** Newest first. */
    readonly lines: readonly UiLogLine[];
    readonly areas: readonly string[];
}

export interface Methods {
    'app.info': { readonly params: NoParams; readonly result: AppInfo };
    'settings.get': { readonly params: NoParams; readonly result: AppSettings };
    'settings.save': { readonly params: { readonly settings: AppSettings }; readonly result: AppSettings };
    /** Opens a folder picker; null when cancelled. */
    'settings.pickBuildsDir': { readonly params: NoParams; readonly result: string | null };
    'builds.list': { readonly params: NoParams; readonly result: BuildsList };
    /** Loads the build in PoB with the target ("saved" when null). Progress also comes as build-state events. */
    'build.select': { readonly params: { readonly buildId: string; readonly target: string | null }; readonly result: BuildSummary };
    'build.settings.get': { readonly params: { readonly buildId: string }; readonly result: BuildSettings };
    'build.settings.save': { readonly params: { readonly buildId: string; readonly settings: BuildSettings }; readonly result: BuildSettings };
    /** The last known state, no network. */
    'signin.status': { readonly params: NoParams; readonly result: SignInState };
    /** Asks the site (one search through the shared limiter). */
    'signin.check': { readonly params: NoParams; readonly result: SignInState };
    /** Opens pathofexile.com's login page; resolves after the window closes and a fresh check. */
    'signin.open': { readonly params: NoParams; readonly result: SignInState };
    /** Opens My Account for the site's own Log out, then clears the app's trade session. */
    'signin.signOut': { readonly params: NoParams; readonly result: SignInState };
    /** The last known rate state, no network. */
    'rate.status': { readonly params: NoParams; readonly result: RateState };
    /** The rate for the current league (looks GGG up when the stored one is out of date). */
    'rate.get': { readonly params: NoParams; readonly result: RateState };
    'rate.refresh': { readonly params: NoParams; readonly result: RateState };
    'rate.setManual': { readonly params: { readonly chaosPerDivine: number }; readonly result: RateState };
    'rate.useGgg': { readonly params: NoParams; readonly result: RateState };
    /** PoB's weighted stats for a build, slot and target, named and heaviest first (the generator, cached). */
    'weights.preview': { readonly params: { readonly buildId: string; readonly slot: GearSlot; readonly target: string }; readonly result: WeightPreview };
    /** Starts a run (one at a time). Progress streams as run events. */
    'run.start': { readonly params: { readonly request: RunRequest }; readonly result: RunHeader };
    'run.pause': { readonly params: NoParams; readonly result: RunPhase };
    'run.resume': { readonly params: NoParams; readonly result: RunPhase };
    'run.cancel': { readonly params: NoParams; readonly result: RunPhase };
    /** Search deeper: the finished run again at Thorough depth over the same searches (no new search calls). */
    'run.deepen': { readonly params: { readonly runId: string }; readonly result: RunHeader };
    /** The current or last run, to redraw the Run view; null before the first run. */
    'run.current': { readonly params: NoParams; readonly result: RunSnapshot | null };
    'run.limits': { readonly params: NoParams; readonly result: LimitPanel };
    /** Recent lines of today's log, newest first, filtered. */
    'logs.recent': { readonly params: { readonly minLevel: UiLogLevel; readonly area: string | null; readonly runId: string | null; readonly limit: number }; readonly result: LogsView };
    /** Asks where to save, then writes a zip of today's log and the run's log (redacted). */
    'logs.export': { readonly params: { readonly runId: string | null }; readonly result: { readonly saved: boolean; readonly file: string | null } };
    /** Opens an item's buy link in the user's browser (after taking a search and a fetch slot from the shared limiter). */
    'link.open': { readonly params: { readonly runId: string; readonly itemId: string }; readonly result: { readonly opened: boolean; readonly message: string | null } };
    'pob.status': { readonly params: NoParams; readonly result: PobUpdateState };
    /** Reads the latest release's version from PoB Community's GitHub. */
    'pob.check': { readonly params: NoParams; readonly result: PobUpdateState };
    /** Downloads, checks and switches to the latest release; refused while a run is going. */
    'pob.update': { readonly params: NoParams; readonly result: PobUpdateState };
    'pob.rollback': { readonly params: NoParams; readonly result: PobUpdateState };
    /** PoB's LICENSE.md as shipped (V6), or null when it can't be read. */
    'app.pobLicense': { readonly params: NoParams; readonly result: { readonly text: string | null } };
    /** Asks in a native dialog; on yes the app quits and the launcher deletes its folders. False when cancelled or not possible. */
    'app.removeFromPc': { readonly params: NoParams; readonly result: { readonly removing: boolean; readonly message: string | null } };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]['params'];
export type Result<M extends MethodName> = Methods[M]['result'];

export interface InvokeRequest<M extends MethodName = MethodName> {
    readonly method: M;
    readonly params: Params<M>;
}

export type IpcErrorCode = 'bad-request' | 'failed' | 'not-allowed';

export interface IpcErrorInfo {
    readonly code: IpcErrorCode;
    readonly message: string;
}

export type InvokeResponse<R = unknown> = { readonly ok: true; readonly result: R } | { readonly ok: false; readonly error: IpcErrorInfo };

// Events ---------------------------------------------------------------------------------------------------

export type NoticeLevel = 'info' | 'warn' | 'error';

/** Pushed from main to the renderer. */
export type MainEvent =
    | { readonly kind: 'notice'; readonly level: NoticeLevel; readonly message: string }
    /** The Builds folder changed (a save added, removed or re-saved). */
    | { readonly kind: 'builds-changed'; readonly list: BuildsList }
    /** The loaded build's state, including automatic reloads when its save changes. */
    | { readonly kind: 'build-state'; readonly state: BuildState }
    | { readonly kind: 'signin-state'; readonly state: SignInState }
    | { readonly kind: 'rate-state'; readonly state: RateState }
    | { readonly kind: 'limits'; readonly panel: LimitPanel }
    | { readonly kind: 'pob-state'; readonly state: PobUpdateState }
    | RunEventUi;

/** What the preload exposes on window.uf. Generic on purpose: new methods need no preload change. */
export interface UfBridge {
    invoke(request: unknown): Promise<unknown>;
    /** Returns an unsubscribe function. */
    onEvent(listener: (event: unknown) => void): () => void;
}
