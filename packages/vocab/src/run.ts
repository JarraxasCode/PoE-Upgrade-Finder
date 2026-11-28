// The words a run is described in: how deep it searches, which listings, the bands, why an item is hidden,
// why a weight was pruned, and the level filter.

const SEARCH_DEPTH_LIST = ['thorough', 'normal', 'quick'] as const;
export type SearchDepth = (typeof SEARCH_DEPTH_LIST)[number];
export const SEARCH_DEPTHS: readonly SearchDepth[] = SEARCH_DEPTH_LIST;

/** Shown by the depth pickers when Thorough is picked (#59). */
export const THOROUGH_NOTE: string =
    'Thorough scores twice as many listings per band and uses up the trade limits faster: searching several slots in a row ' +
    'means waiting for them to free up.';

const LISTING_TYPE_LIST = ['securable', 'online'] as const;
/** Instant buyout only, or whisper listings too (D6); the trade site's `status` option. */
export type ListingType = (typeof LISTING_TYPE_LIST)[number];
export const LISTING_TYPES: readonly ListingType[] = LISTING_TYPE_LIST;

/** A main band, or the "slightly over budget" band that is shown but never picked. */
export type BandRole = 'main' | 'over';

const JUNK_REASON_LIST = ['floor', 'no-gain', 'low-gain', 'duplicate', 'dominated'] as const;
/** Why the junk filter hid an item (PLAN.md, Scoring & ranking, step 5). */
export type JunkReason = (typeof JUNK_REASON_LIST)[number];
export const JUNK_REASONS: readonly JunkReason[] = JUNK_REASON_LIST;

const SKIP_REASON_LIST = ['not-for-slot', 'unidentified', 'already-fetched', 'malformed', 'excluded-mod'] as const;
/**
 * Why a fetched listing wasn't scored: PoB won't equip it in the slot (e.g. a Weapon 2 type that doesn't fit beside
 * Weapon 1, #39), it's unidentified, an earlier band already had it, it couldn't be read, or it has a hybrid mod the
 * slot plan excludes (#38: dropped after the fetch, since the site can't filter mods).
 */
export type SkipReason = (typeof SKIP_REASON_LIST)[number];
export const SKIP_REASONS: readonly SkipReason[] = SKIP_REASON_LIST;

/** Listings dropped for one excluded hybrid mod (#38), named as the slot plan's spec names it. */
export interface ExcludedModCount {
    readonly name: string;
    readonly dropped: number;
}

/** "(A)"; with several mods, each with its count: "(A: 2; B: 1)". */
export function excludedModNames(counts: readonly ExcludedModCount[]): string {
    const names: string =
        counts.length === 1 ? (counts[0]?.name ?? '') : counts.map((c: ExcludedModCount) => `${c.name}: ${c.dropped}`).join('; ');
    return `(${names})`;
}

/** "2 listings dropped for an excluded mod (A)". */
export function excludedModText(counts: readonly ExcludedModCount[]): string {
    const total: number = counts.reduce((sum: number, c: ExcludedModCount) => sum + c.dropped, 0);
    return `${total} listing${total === 1 ? '' : 's'} dropped for an excluded mod ${excludedModNames(counts)}`;
}

const WEIGHT_SOURCE_LIST = ['pob'] as const;
/** Which generator made a weight list: PoB's own (v0.1 on); `'own'` joins in v0.3 (issue #47). */
export type WeightSource = (typeof WEIGHT_SOURCE_LIST)[number];
export const WEIGHT_SOURCES: readonly WeightSource[] = WEIGHT_SOURCE_LIST;

const PRUNE_REASON_LIST = [
    'excluded',
    'included',
    'base-cannot-roll',
    'same-group',
    'prefixes-full',
    'suffixes-full',
    'affixes-full',
    'no-room',
    'defences',
] as const;
/** Why the slot plan took a weight out of the weighted group (PLAN.md, "v2a: the slot plan"). */
export type PruneReason = (typeof PRUNE_REASON_LIST)[number];
export const PRUNE_REASONS: readonly PruneReason[] = PRUNE_REASON_LIST;

/**
 * The level requirement filter (issue #22): up to the character's level (the default, as in v1), none, or up to a
 * level the user sets (to buy ahead of levelling, or to stay under a lower one).
 */
export type LevelFilter = { readonly kind: 'character' } | { readonly kind: 'off' } | { readonly kind: 'max'; readonly level: number };
export const LEVEL_FILTER_KINDS: readonly LevelFilter['kind'][] = ['character', 'off', 'max'];
/** Character levels run 1 to 100. */
export const MAX_CHARACTER_LEVEL: number = 100;
