// The one tooltip on screen (PLAN.md, Phase 4): an item card or a short explanation. Whatever is hovered or
// focused sets it with a key; the element with that key carries the CSS anchor the tooltip is positioned
// against (CSS anchor positioning: the CSP allows no inline styles, so nothing is positioned from script).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { ItemView } from '@poe-upgrade-finder/vocab';

export type TipContent =
    | { readonly kind: 'item'; readonly view: ItemView }
    | { readonly kind: 'info'; readonly title: string; readonly lines: readonly string[] };

export interface TipState {
    readonly key: string;
    readonly content: TipContent;
}

export const tip: Signal<TipState | null> = signal<TipState | null>(null);

export function showTip(key: string, view: ItemView | null): void {
    tip.value = view === null ? null : { key: key, content: { kind: 'item', view: view } };
}

export function showInfo(key: string, title: string, lines: readonly string[]): void {
    tip.value = { key: key, content: { kind: 'info', title: title, lines: lines } };
}

/** Clears the tooltip only if it is still this key's (a quick move may already have shown the next one). */
export function hideTip(key: string): void {
    if (tip.value?.key === key) {
        tip.value = null;
    }
}

/** The class that makes an element the tooltip's anchor, when it holds the tooltip. */
export function anchorClass(key: string): string {
    return tip.value?.key === key ? ' tip-anchor' : '';
}
