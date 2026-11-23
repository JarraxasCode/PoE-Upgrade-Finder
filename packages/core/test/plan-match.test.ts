import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StatLine } from '@poe-upgrade-finder/trade';
import { comparedDefence, lineNumber, lineValue, matchPlan } from '../src/plan-match.ts';
import type { PlanMatch, RequirementMatch } from '../src/plan-match.ts';
import type { SearchRequirement } from '../src/spec.ts';

const DEX: string = 'stat_3261801346';
const ALL_ATTR: string = 'stat_1379411836';
const STR: string = 'stat_4080418644';
const LIFE: string = 'stat_3299347043';
const RARITY: string = 'stat_3917489142';
const MS: string = 'stat_2250533757';

function line(statId: string, text: string, kind: StatLine['kind'] = 'explicit'): StatLine {
    return { statId: statId, kind: kind, text: text };
}

function need(statId: string, min?: number, max?: number, extra: Partial<SearchRequirement> = {}): SearchRequirement {
    return {
        statId: statId,
        ...(min === undefined ? {} : { min: min }),
        ...(max === undefined ? {} : { max: max }),
        origin: 'plan',
        label: `Required: ${statId}, from plan`,
        ...extra,
    };
}

function onlyRequirement(m: PlanMatch): RequirementMatch {
    const r: RequirementMatch | undefined = m.requirements[0];
    assert.ok(r);
    return r;
}

test('line numbers: the first number, signed; "Adds # to #" is averaged as the site does', () => {
    assert.equal(lineNumber('+14 to maximum Life'), 14);
    assert.equal(lineNumber('-5% to Fire Resistance'), -5);
    assert.equal(lineNumber('Adds 10 to 21 Fire Damage to Attacks'), 15.5);
    assert.equal(lineNumber('Cannot be Frozen'), null);
    assert.equal(lineValue('20% reduced Mana Cost of Skills', '#% increased Mana Cost of Skills'), -20);
    assert.equal(lineValue('20% reduced Mana Cost of Skills', '#% reduced Mana Cost of Skills'), 20);
    assert.equal(lineValue('10% increased Mana Cost of Skills', '#% reduced Mana Cost of Skills'), -10);
});

test('an explicit include counts explicit, crafted and fractured lines with the stat, summed (V24)', () => {
    const lines: StatLine[] = [
        line(`explicit.${LIFE}`, '+40 to maximum Life'),
        line(`crafted.${LIFE}`, '+25 to maximum Life', 'crafted'),
        line(`implicit.${LIFE}`, '+10 to maximum Life', 'implicit'),
    ];
    const r: RequirementMatch = onlyRequirement(
        matchPlan({ requirements: [need(`explicit.${LIFE}`, 60)], exclusions: [], defences: [] }, { statLines: lines, properties: [] }),
    );
    assert.equal(r.status, 'met');
    assert.equal(r.total, 65);
    assert.deepEqual(
        r.lines.map((l) => l.kind),
        ['explicit', 'crafted'],
    );
    const short: RequirementMatch = onlyRequirement(
        matchPlan({ requirements: [need(`explicit.${LIFE}`, 70)], exclusions: [], defences: [] }, { statLines: lines, properties: [] }),
    );
    assert.equal(short.status, 'missed');
});

test('a pseudo total counts every source with its factor: +all Attributes to Dex, half of Strength to life', () => {
    const lines: StatLine[] = [
        line(`implicit.${DEX}`, '+20 to Dexterity', 'implicit'),
        line(`explicit.${ALL_ATTR}`, '+12 to all Attributes'),
        line(`explicit.${STR}`, '+30 to Strength'),
        line(`explicit.${LIFE}`, '+50 to maximum Life'),
    ];
    const spec = {
        requirements: [need('pseudo.pseudo_total_dexterity', 30), need('pseudo.pseudo_total_life', 70, 80)],
        exclusions: [],
        defences: [],
    };
    const m: PlanMatch = matchPlan(spec, { statLines: lines, properties: [] });
    const [dex, life] = m.requirements;
    assert.ok(dex && life);
    assert.equal(dex.total, 32);
    assert.equal(dex.status, 'met');
    // 50 + 0.5 × 12 (all Attributes) + 0.5 × 30 (Strength) = 71.
    assert.equal(life.total, 71);
    assert.equal(life.status, 'met');
    assert.deepEqual(
        life.lines.map((l) => l.factor),
        [0.5, 0.5, 1],
    );
});

test('an include with no range is met by any line with the stat; an implicit include counts implicits only', () => {
    const lines: StatLine[] = [line(`explicit.${MS}`, '25% increased Movement Speed')];
    const m: PlanMatch = matchPlan(
        { requirements: [need(`explicit.${MS}`), need(`implicit.${MS}`)], exclusions: [], defences: [] },
        { statLines: lines, properties: [] },
    );
    assert.deepEqual(
        m.requirements.map((r) => r.status),
        ['met', 'missed'],
    );
});

test('a negated include reads in its own terms: reduced 20 to 32 is met by "25% reduced", total 25', () => {
    const id: string = 'explicit.stat_474294393';
    const r: RequirementMatch = onlyRequirement(
        matchPlan(
            {
                requirements: [need(id, -32, -20, { siteText: '#% increased Mana Cost of Skills', negated: true })],
                exclusions: [],
                defences: [],
            },
            { statLines: [line(id, '25% reduced Mana Cost of Skills')], properties: [] },
        ),
    );
    assert.equal(r.status, 'met');
    assert.equal(r.total, 25);
});

test('exclusions: met when no line has the stat, crafted lines included; unknown without lines', () => {
    const spec = {
        requirements: [need(`explicit.${LIFE}`)],
        exclusions: [{ statId: `explicit.${RARITY}`, origin: 'plan' as const, label: 'Excluded: rarity, from plan' }],
        defences: [],
    };
    const clean: PlanMatch = matchPlan(spec, { statLines: [line(`explicit.${LIFE}`, '+40 to maximum Life')], properties: [] });
    assert.equal(clean.exclusions[0]?.status, 'met');
    const crafted: PlanMatch = matchPlan(spec, {
        statLines: [line(`crafted.${RARITY}`, '15% increased Rarity of Items found', 'crafted')],
        properties: [],
    });
    assert.equal(crafted.exclusions[0]?.status, 'missed');
    const unknown: PlanMatch = matchPlan(spec, { statLines: undefined, properties: undefined });
    assert.equal(unknown.exclusions[0]?.status, 'unknown');
    assert.equal(unknown.requirements[0]?.status, 'unknown');
});

test('defences are compared at 20% quality: a 0% item listed at 418 Armour passes min 500 (V24 #24 live run)', () => {
    assert.ok(Math.abs(comparedDefence(418, 0) - 501.6) < 1e-9);
    assert.equal(comparedDefence(600, 20), 600);
    assert.equal(comparedDefence(600, 28), 600, 'never lowered above 20% (seen live: 702 at 24% passed min 700)');
    const spec = {
        requirements: [],
        exclusions: [],
        defences: [
            { defence: 'armour' as const, min: 500, origin: 'plan' as const, label: 'Armour (≥ 500), from plan' },
            { defence: 'energyShield' as const, max: 0, origin: 'plan' as const, label: 'Energy Shield (≤ 0), from plan' },
        ],
    };
    const m: PlanMatch = matchPlan(spec, { statLines: [], properties: ['Quality: +0%', 'Armour: 418'] });
    const [armour, es] = m.defences;
    assert.ok(armour && es);
    assert.equal(armour.listed, 418);
    assert.equal(armour.status, 'met');
    assert.equal(es.listed, 0, 'no property line: 0');
    assert.equal(es.status, 'met');
    const low: PlanMatch = matchPlan(spec, { statLines: [], properties: ['Quality: +10%', 'Armour: 418'] });
    assert.equal(low.defences[0]?.status, 'missed', '418 × 1.2 / 1.1 = 456');
});
