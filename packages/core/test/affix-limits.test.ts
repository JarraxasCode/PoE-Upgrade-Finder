import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseAffixes, largestLimits } from '../src/affix-limits.ts';
import type { BaseAffixes } from '@poe-upgrade-finder/vocab';

// The implicit lines exactly as PoB 2.68.1 has them (Data/ModItemExclusive.lua, MaxPrefixMaxSuffixImplicit*),
// with the limits and magnitudes the game gives each base.
const CASES: readonly (readonly [string, readonly string[], BaseAffixes])[] = [
    [
        'Cogwork Ring',
        [
            '-1 Prefix Modifier allowed',
            '+1 Suffix Modifier allowed',
            'Implicit Modifiers Cannot Be Changed',
            '25% increased Suffix Modifier magnitudes',
        ],
        { limits: { prefix: 2, suffix: 4 }, magnitudes: { prefix: 0, suffix: 25 } },
    ],
    [
        'Geodesic Ring',
        [
            '+1 Prefix Modifier allowed',
            '-1 Suffix Modifier allowed',
            'Implicit Modifiers Cannot Be Changed',
            '25% increased Prefix Modifier magnitudes',
        ],
        { limits: { prefix: 4, suffix: 2 }, magnitudes: { prefix: 25, suffix: 0 } },
    ],
    [
        'Composite Ring',
        ['+3 Prefix Modifiers allowed', '-3 Suffix Modifiers allowed', 'Implicit Modifiers Cannot Be Changed'],
        { limits: { prefix: 6, suffix: 0 }, magnitudes: { prefix: 0, suffix: 0 } },
    ],
    [
        'Manifold Ring',
        [
            '+1 Prefix Modifier allowed',
            '-2 Suffix Modifiers allowed',
            'Implicit Modifiers Cannot Be Changed',
            '50% increased Prefix Modifier magnitudes',
        ],
        { limits: { prefix: 4, suffix: 1 }, magnitudes: { prefix: 50, suffix: 0 } },
    ],
    [
        'Ratcheting Ring',
        ['-3 Prefix Modifiers allowed', '+3 Suffix Modifiers allowed', 'Implicit Modifiers Cannot Be Changed'],
        { limits: { prefix: 0, suffix: 6 }, magnitudes: { prefix: 0, suffix: 0 } },
    ],
    [
        'Helical Ring',
        [
            '-2 Prefix Modifiers allowed',
            '+1 Suffix Modifier allowed',
            'Implicit Modifiers Cannot Be Changed',
            '50% increased Suffix Modifier magnitudes',
        ],
        { limits: { prefix: 1, suffix: 4 }, magnitudes: { prefix: 0, suffix: 50 } },
    ],
    [
        'Simplex Amulet',
        [
            '-2 Prefix Modifiers allowed',
            '-1 Suffix Modifier allowed',
            'Implicit Modifiers Cannot Be Changed',
            '100% increased Explicit Modifier magnitudes',
        ],
        { limits: { prefix: 1, suffix: 2 }, magnitudes: { prefix: 100, suffix: 100 } },
    ],
    [
        'Focused Amulet',
        [
            '-1 Prefix Modifier allowed',
            '-2 Suffix Modifiers allowed',
            'Implicit Modifiers Cannot Be Changed',
            '100% increased Explicit Modifier magnitudes',
        ],
        { limits: { prefix: 2, suffix: 1 }, magnitudes: { prefix: 100, suffix: 100 } },
    ],
    // Ordinary bases: an implicit that says nothing about affixes, and none at all.
    [
        'Two-Stone Ring',
        ['+(12-16)% to Fire and Cold Resistances'],
        { limits: { prefix: 3, suffix: 3 }, magnitudes: { prefix: 0, suffix: 0 } },
    ],
    ['Sorcerer Boots', [], { limits: { prefix: 3, suffix: 3 }, magnitudes: { prefix: 0, suffix: 0 } }],
];

test('affix limits and magnitudes per base, from PoB 2.68.1 implicit lines (issue #37)', () => {
    for (const [name, lines, expected] of CASES) {
        const implicits = lines.length === 0 ? [] : [{ modId: name, lines: lines, stats: [] }];
        assert.deepEqual(baseAffixes({ implicits: implicits }), expected, name);
    }
});

test('the largest limits over several bases', () => {
    assert.deepEqual(
        largestLimits([
            { prefix: 0, suffix: 6 },
            { prefix: 6, suffix: 0 },
            { prefix: 3, suffix: 3 },
        ]),
        { prefix: 6, suffix: 6 },
    );
    assert.deepEqual(largestLimits([]), { prefix: 0, suffix: 0 });
});
