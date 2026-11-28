// The Search form's own choices for the next run. Depth and listing type default to Settings (null: use the
// setting); slot, budget and target are remembered per build (BuildSettings).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { ListingType, SearchDepth } from '@poe-upgrade-finder/vocab';

export const depthChoice: Signal<SearchDepth | null> = signal<SearchDepth | null>(null);
export const listingChoice: Signal<ListingType | null> = signal<ListingType | null>(null);
/** The budget box as typed (saved to the build on blur). */
export const budgetText: Signal<string | null> = signal<string | null>(null);
/** The min price box as typed (saved to the build on blur); empty for none. */
export const minBudgetText: Signal<string | null> = signal<string | null>(null);
