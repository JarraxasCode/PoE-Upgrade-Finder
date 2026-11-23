import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statChanges } from '../src/run/stat-changes.ts';

const stats = (values: Record<string, number>) => ({ damage: 1, values: values });

test('stat changes: PoB totals against the baseline, rounded, noise dropped, in reading order', () => {
    const before = stats({
        Life: 4100,
        FireResistTotal: 90,
        ColdResistTotal: 80,
        FireResist: 75,
        MissingFireResist: 0,
        Armour: 10000,
        Str: 200,
        EffectiveMovementSpeedMod: 1.25,
    });
    const after = stats({
        Life: 4080.4,
        FireResistTotal: 110,
        ColdResistTotal: 80.3,
        FireResist: 76,
        MissingFireResist: 0,
        Armour: 10004,
        Str: 236,
        EffectiveMovementSpeedMod: 1.3,
    });
    assert.deepEqual(statChanges(before, after), [
        { label: 'Life', delta: -20, unit: '' },
        { label: 'Fire res', delta: 20, unit: '%' },
        { label: 'Max fire res', delta: 1, unit: '%' },
        { label: 'Strength', delta: 36, unit: '' },
        { label: 'Movement speed', delta: 5, unit: '%' },
    ]);
});

test('a stat PoB leaves out on one side counts from 0 (spell suppression gained)', () => {
    assert.deepEqual(statChanges(stats({}), stats({ SpellSuppressionChance: 12 })), [{ label: 'Spell suppression', delta: 12, unit: '%' }]);
});
