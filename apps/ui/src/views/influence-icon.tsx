// Small influence marks for the slot plan editor (issue #27). GGG's own symbols aren't at a known CDN URL, so
// these are simple drawn glyphs, coloured by CSS (fill/stroke follow currentColor; the CSP allows inline SVG).

import type { JSX } from 'preact';
import type { SlotInfluence } from '@poe-upgrade-finder/vocab';

/** The influences and the two eldritch implicit sources. */
export type MarkKind = 'shaper' | 'elder' | 'crusader' | 'redeemer' | 'hunter' | 'warlord' | 'exarch' | 'eater';

/** PoB's pool names to the in-game influence names (eyrie is the Redeemer, basilisk the Hunter, adjudicator the Warlord). */
export const MARK_OF_INFLUENCE: Readonly<Record<Exclude<SlotInfluence, 'none'>, MarkKind>> = {
    shaper: 'shaper',
    elder: 'elder',
    crusader: 'crusader',
    eyrie: 'redeemer',
    basilisk: 'hunter',
    adjudicator: 'warlord',
};

const STROKE = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
} as const;

function glyph(kind: MarkKind): JSX.Element {
    switch (kind) {
        case 'shaper':
            return (
                <>
                    <circle cx="8" cy="8" r="6" {...STROKE} />
                    <circle cx="8" cy="8" r="2.2" fill="currentColor" />
                </>
            );
        case 'elder':
            return (
                <>
                    <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" {...STROKE} />
                    <path d="M8 5 11 8 8 11 5 8Z" fill="currentColor" />
                </>
            );
        case 'crusader':
            return <path d="M6.6 1.5h2.8v5.1h5.1v2.8H9.4v5.1H6.6V9.4H1.5V6.6h5.1z" fill="currentColor" />;
        case 'redeemer':
            return <path d="M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5" {...STROKE} />;
        case 'hunter':
            return <path d="M8 1.5 13 8H10v6.5H6V8H3Z" fill="currentColor" />;
        case 'warlord':
            return <path d="M8 1.5 14 3.8v4.1c0 3.3-2.5 5.6-6 6.6-3.5-1-6-3.3-6-6.6V3.8Z" fill="currentColor" />;
        case 'exarch':
            return (
                <path
                    d="M8 1.2c.6 2.8 4.2 4.4 4.2 8.4a4.2 4.2 0 0 1-8.4 0c0-2.3 1.3-3.4 1.9-5.1.8 1 1.2 2 1.2 3 1.3-1.6 1.6-3.8 1.1-6.3z"
                    fill="currentColor"
                />
            );
        case 'eater':
            return (
                <>
                    <path d="M1.5 8c1.9-3.3 4.2-4.8 6.5-4.8s4.6 1.5 6.5 4.8c-1.9 3.3-4.2 4.8-6.5 4.8S3.4 11.3 1.5 8Z" {...STROKE} />
                    <circle cx="8" cy="8" r="2.3" fill="currentColor" />
                </>
            );
    }
}

export function InfluenceIcon(props: { readonly kind: MarkKind }): JSX.Element {
    return (
        <svg class={`inf-icon mark-${props.kind}`} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            {glyph(props.kind)}
        </svg>
    );
}
