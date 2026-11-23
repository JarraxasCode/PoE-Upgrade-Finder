import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptySlotPlan } from '@poe-upgrade-finder/ipc';
import type { ModOption, ModPick, SlotEditorData, SlotPlan, StatOption } from '@poe-upgrade-finder/ipc';
import {
    conflictOf,
    editorItemType,
    fuzzyScore,
    kindLabel,
    excludeRows,
    listOptions,
    rowsOf,
    optionLabel,
    optionOf,
    parseRoll,
    pickOf,
    pickProblem,
    planOptions,
    statBounds,
    withBase,
    withItemType,
    withoutPick,
    withPick,
    withRange,
    withRule,
} from '../src/slot-plan-model.ts';
import type { PlanOption } from '../src/slot-plan-model.ts';

const ES: string = 'explicit.stat_4015621042';
const STUN: string = 'explicit.stat_2511217560';
const LIFE: string = 'explicit.stat_3299347043';
const MS: string = 'explicit.stat_2250533757';
const COLD: string = 'explicit.stat_4220027924';
const REQ: string = 'explicit.stat_3639275092';
const IMP_MS: string = 'implicit.stat_2250533757';

function stat(statId: string, text: string, roll: readonly [number, number] | null, negate: boolean = false): StatOption {
    return { statId: statId, text: text, siteText: text, negate: negate, roll: roll };
}

function mod(partial: Partial<ModOption> & Pick<ModOption, 'group' | 'text' | 'stats'>): ModOption {
    return {
        position: 'prefix',
        type: 'Prefix',
        source: 'natural',
        rank: null,
        influence: 'none',
        tiers: [{ level: 1, lines: [] }],
        bases: ['Sorcerer Boots', 'Slink Boots'],
        ...partial,
    };
}

const MODS: readonly ModOption[] = [
    mod({ group: 'MovementVelocity', text: '#% increased Movement Speed', stats: [stat(MS, '#% increased Movement Speed', [10, 35])] }),
    mod({ group: 'IncreasedLife', text: '+# to maximum Life', stats: [stat(LIFE, '+# to maximum Life', [3, 99])] }),
    mod({
        group: 'DefencesPercent',
        text: '#% increased Energy Shield',
        stats: [stat(ES, '#% increased Energy Shield', [11, 100])],
        bases: ['Sorcerer Boots'],
    }),
    mod({
        group: 'DefencesPercentAndStunRecovery',
        text: '#% increased Energy Shield / #% increased Stun and Block Recovery',
        stats: [stat(ES, '#% increased Energy Shield', [6, 42]), stat(STUN, '#% increased Stun and Block Recovery', [6, 17])],
        bases: ['Sorcerer Boots'],
    }),
    mod({
        group: 'DefencesPercent',
        influence: 'shaper',
        text: '#% increased Energy Shield (Shaper)',
        stats: [stat(LIFE, 'x', [1, 1])],
        bases: ['Sorcerer Boots'],
    }),
    mod({
        group: 'ColdResistance',
        position: 'suffix',
        type: 'Suffix',
        text: '+#% to Cold Resistance',
        stats: [stat(COLD, '+#% to Cold Resistance', [6, 48])],
    }),
    mod({
        group: 'ReducedRequirements',
        position: 'suffix',
        type: 'Suffix',
        text: '#% reduced Attribute Requirements',
        stats: [stat(REQ, '#% reduced Attribute Requirements', [18, 32], true)],
    }),
    mod({ group: 'X1', influence: 'elder', text: 'elder thing', stats: [stat('explicit.stat_1', 'a', [1, 2])] }),
    mod({ group: 'X2', influence: 'crusader', text: 'crusader thing', stats: [stat('explicit.stat_2', 'b', [1, 2])] }),
    mod({ group: 'X3', influence: 'eyrie', text: 'redeemer thing', stats: [stat('explicit.stat_3', 'c', [1, 2])] }),
    mod({
        group: 'MovementVelocity',
        position: 'implicit',
        type: 'Exarch',
        text: '#% increased Movement Speed',
        stats: [stat(IMP_MS, '#% increased Movement Speed', [3, 8])],
    }),
    mod({
        group: 'MovementVelocity',
        position: 'implicit',
        type: 'Corrupted',
        text: '#% increased Movement Speed',
        stats: [stat(IMP_MS, '#% increased Movement Speed', [8, 10])],
    }),
];

const DATA: SlotEditorData = {
    totals: [],
    pobVersion: '2.68.1',
    slot: 'Boots',
    itemType: 'Boots',
    base: null,
    bases: [
        {
            name: 'Sorcerer Boots',
            tradeType: 'Sorcerer Boots',
            level: 67,
            defences: { energyShield: [42, 51] },
            implicits: [],
            influences: ['shaper', 'elder'],
            icon: null,
        },
        {
            name: 'Slink Boots',
            tradeType: 'Slink Boots',
            level: 69,
            defences: { evasion: [228, 262] },
            implicits: [],
            influences: ['shaper', 'elder'],
            icon: null,
        },
        {
            name: 'Two-Toned Boots (Armour/Evasion)',
            tradeType: 'Two-Toned Boots',
            level: 70,
            defences: { armour: [126, 145], evasion: [126, 145] },
            implicits: [
                {
                    lines: ['+(8-12)% to Fire and Cold Resistances'],
                    stats: [stat('implicit.stat_9', '+#% to Fire and Cold Resistances', [8, 12])],
                },
            ],
            influences: [],
            icon: null,
        },
    ],
    mods: MODS,
};

const OPTIONS: readonly PlanOption[] = planOptions(DATA);

function find(text: string): PlanOption {
    const o: PlanOption | undefined = OPTIONS.find((x: PlanOption) => x.text === text);
    assert.ok(o, text);
    return o;
}

function planWith(...picks: ModPick[]): SlotPlan {
    return { slot: 'Boots', itemType: 'Boots', base: null, picks: picks };
}

test('options: one per key; Exarch and Corrupted sharing a stat merge; base implicits are options', () => {
    const ms: readonly PlanOption[] = OPTIONS.filter((o: PlanOption) => o.position === 'implicit' && o.group === 'MovementVelocity');
    assert.equal(ms.length, 1);
    assert.deepEqual(ms[0]?.types, ['Exarch', 'Corrupted']);
    assert.deepEqual(ms[0]?.stats[0]?.roll, [3, 10]);
    const base = OPTIONS.find((o: PlanOption) => o.types.includes('Base'));
    assert.equal(base?.text, '+(8-12)% to Fire and Cold Resistances');
    assert.equal(base?.group, null);
    assert.deepEqual(base?.bases, ['Two-Toned Boots (Armour/Evasion)']);
});

test('a pick maps back to its option', () => {
    const o: PlanOption = find('+# to maximum Life');
    const pick: ModPick = pickOf(o, 'include');
    assert.deepEqual(pick, { position: 'prefix', group: 'IncreasedLife', influence: 'none', rule: 'include', stats: [{ statId: LIFE }] });
    assert.equal(optionOf(OPTIONS, { ...pick, stats: [{ statId: LIFE, min: 60 }] })?.key, o.key);
});

test('an implicit and an affix may share a mod group (issue #30)', () => {
    // Movement speed: a prefix and an implicit (Exarch or corrupted, merged into one option), one PoB group.
    const implicit: PlanOption | undefined = OPTIONS.find((o: PlanOption) => o.position === 'implicit' && o.group === 'MovementVelocity');
    const prefix: PlanOption | undefined = OPTIONS.find((o: PlanOption) => o.position === 'prefix' && o.group === 'MovementVelocity');
    assert.ok(prefix !== undefined && implicit !== undefined);
    assert.equal(conflictOf(OPTIONS, planWith(pickOf(prefix, 'include')), implicit, 'include', null), undefined);
    assert.equal(conflictOf(OPTIONS, planWith(pickOf(implicit, 'include')), prefix, 'include', null), undefined);
});

test('conflicts: already picked, same group, include vs exclude, influences, eldritch', () => {
    const es: ModPick = pickOf(find('#% increased Energy Shield'), 'include');
    const plan: SlotPlan = planWith(es);
    assert.equal(conflictOf(OPTIONS, plan, find('#% increased Energy Shield'), 'include', null), 'Already in the plan');
    assert.equal(conflictOf(OPTIONS, plan, find('#% increased Energy Shield'), 'include', 0), undefined, "a row doesn't block itself");
    assert.match(conflictOf(OPTIONS, plan, find('#% increased Energy Shield (Shaper)'), 'include', null) ?? '', /Same mod group/);
    // An exclude isn't held to the group rule, but can't exclude what's included.
    assert.equal(conflictOf(OPTIONS, plan, find('#% increased Energy Shield (Shaper)'), 'exclude', null), undefined);
    assert.match(
        conflictOf(OPTIONS, plan, find('#% increased Energy Shield / #% increased Stun and Block Recovery'), 'exclude', null) ?? '',
        /includes this stat/,
    );
    // The hybrid carries ES too, but it's another group: it may be the mod that meets the include.
    assert.equal(
        conflictOf(OPTIONS, plan, find('#% increased Energy Shield / #% increased Stun and Block Recovery'), 'include', null),
        undefined,
    );

    const two: SlotPlan = planWith(pickOf(find('elder thing'), 'include'), pickOf(find('crusader thing'), 'include'));
    assert.match(conflictOf(OPTIONS, two, find('redeemer thing'), 'include', null) ?? '', /Elder and Crusader: an item has at most two/);
    assert.equal(conflictOf(OPTIONS, two, find('redeemer thing'), 'include', 1), undefined, 'replacing one of the two');
    assert.equal(conflictOf(OPTIONS, two, find('redeemer thing'), 'exclude', null), undefined);
});

test('listing: by position, pickable first, fuzzy', () => {
    const plan: SlotPlan = planWith(pickOf(find('#% increased Energy Shield'), 'include'));
    const prefixes = listOptions(OPTIONS, plan, 'prefix', 'include', '', null);
    assert.ok(prefixes.every((l) => l.option.position === 'prefix'));
    assert.equal(prefixes.at(-1)?.conflict !== undefined, true, 'blocked ones last');
    assert.equal(prefixes[0]?.option.influence, 'none', 'plain mods before influenced ones');
    const life = listOptions(OPTIONS, plan, 'prefix', 'include', 'max life', null);
    assert.equal(life[0]?.option.text, '+# to maximum Life');
    assert.equal(listOptions(OPTIONS, plan, 'prefix', 'include', 'shaper', null)[0]?.option.influence, 'shaper');
    assert.equal(listOptions(OPTIONS, plan, 'suffix', 'include', 'cold res', null)[0]?.option.text, '+#% to Cold Resistance');
});

test('rows hold includes only; excludes have their own list over every position (issue #29)', () => {
    const plan: SlotPlan = planWith(
        pickOf(find('#% increased Energy Shield'), 'include'),
        pickOf(find('+# to maximum Life'), 'exclude'),
        pickOf(find('+#% to Cold Resistance'), 'exclude'),
    );
    assert.deepEqual(rowsOf(plan).prefix, [0]);
    assert.deepEqual(rowsOf(plan).suffix, []);
    assert.deepEqual(excludeRows(plan), [1, 2]);
    const any = listOptions(OPTIONS, plan, null, 'exclude', '', null);
    assert.ok(any.some((l) => l.option.position === 'prefix') && any.some((l) => l.option.position === 'suffix'));
});

test('fuzzy score', () => {
    assert.equal(fuzzyScore('', 'anything'), 0);
    assert.ok((fuzzyScore('life', '+# to maximum Life') ?? 0) > 0);
    assert.equal(fuzzyScore('life mana', '+# to maximum Life'), undefined);
    assert.ok(fuzzyScore('movspd', '#% increased Movement Speed') !== undefined, 'letters in order');
    assert.ok((fuzzyScore('move', 'Movement Speed') ?? 0) > (fuzzyScore('ove', 'Movement Speed') ?? 0), 'a word start ranks higher');
});

test('bounds: the most a stat can total, best mod per group, 3 per side', () => {
    const es: PlanOption = find('#% increased Energy Shield');
    const b = statBounds(OPTIONS, es.stats[0] ?? stat(ES, '', null));
    // ES% 100 + the hybrid's 42 (another group).
    assert.deepEqual(b, { low: 6, high: 142 });
    const req = find('#% reduced Attribute Requirements').stats[0];
    assert.ok(req);
    assert.deepEqual(statBounds(OPTIONS, req), { low: 18, high: 32 });
    const imp = OPTIONS.find((o: PlanOption) => o.position === 'implicit' && o.group === 'MovementVelocity')?.stats[0];
    assert.ok(imp);
    assert.deepEqual(statBounds(OPTIONS, imp), { low: 3, high: 10 }, 'implicits only count implicits');
});

test('rolls typed', () => {
    assert.equal(parseRoll(''), null);
    assert.equal(parseRoll(' 35 '), 35);
    assert.equal(parseRoll('2.5'), 2.5);
    assert.equal(parseRoll('abc'), undefined);
});

test('edits: type, base, picks, rule, range', () => {
    const empty: SlotPlan = emptySlotPlan('Weapon 1');
    assert.equal(editorItemType('Weapon 1', empty, 'One Handed Sword'), 'One Handed Sword');
    assert.equal(editorItemType('Weapon 1', empty, 'Fishing Rod'), 'Bow', "a type the slot can't hold falls back to the slot's first");
    assert.equal(editorItemType('Weapon 1', { ...empty, itemType: 'Bow' }, 'One Handed Sword'), 'Bow');

    // Picking the equipped type with nothing else stays an empty plan (searches as v0.1).
    assert.equal(withItemType(empty, 'One Handed Sword', 'One Handed Sword').itemType, null);
    const bow: SlotPlan = withItemType(empty, 'Bow', 'One Handed Sword');
    assert.equal(bow.itemType, 'Bow');
    const withB: SlotPlan = withBase(bow, 'Spine Bow', 'Bow', 'One Handed Sword');
    assert.equal(withB.base, 'Spine Bow');
    assert.deepEqual(withItemType({ ...withB, picks: [pickOf(find('+# to maximum Life'), 'include')] }, 'Wand', 'One Handed Sword'), {
        slot: 'Weapon 1',
        itemType: 'Wand',
        base: null,
        picks: [],
    });

    const boots: SlotPlan = emptySlotPlan('Boots');
    let p: SlotPlan = withPick(boots, null, pickOf(find('+# to maximum Life'), 'include'), 'Boots');
    assert.equal(p.itemType, 'Boots', 'a mod names the type');
    p = withRange(p, 0, LIFE, 'min', 70);
    p = withRange(p, 0, LIFE, 'max', 90);
    assert.deepEqual(p.picks[0]?.stats, [{ statId: LIFE, min: 70, max: 90 }]);
    p = withRange(p, 0, LIFE, 'min', null);
    assert.deepEqual(p.picks[0]?.stats, [{ statId: LIFE, max: 90 }]);
    p = withRule(p, 0, 'exclude');
    assert.deepEqual(p.picks[0], { ...pickOf(find('+# to maximum Life'), 'exclude') }, 'an exclude drops its range');
    p = withPick(p, 0, pickOf(find('#% increased Movement Speed'), 'include'), 'Boots');
    assert.equal(p.picks.length, 1);
    assert.equal(p.picks[0]?.group, 'MovementVelocity');
    assert.deepEqual(withoutPick(p, 0, 'Boots', 'Boots'), boots, 'the last mod out: back to empty');
});

test('a pick the base no longer rolls shows a problem; the bases note', () => {
    const plan: SlotPlan = { ...planWith(pickOf(find('#% increased Energy Shield'), 'include')), base: 'Slink Boots' };
    const slink: readonly PlanOption[] = planOptions({
        ...DATA,
        base: 'Slink Boots',
        mods: MODS.filter((m: ModOption) => m.bases.includes('Slink Boots')),
    });
    assert.equal(pickProblem(slink, plan, 0, 'Slink Boots'), "Can't roll on Slink Boots");
    assert.equal(pickProblem(OPTIONS, plan, 0, null), undefined);
});

test('labels read like the item, with rolls', () => {
    assert.equal(optionLabel(find('#% increased Movement Speed')), '(10–35)% increased Movement Speed');
    assert.equal(
        optionLabel(find('#% increased Energy Shield / #% increased Stun and Block Recovery')),
        '(6–42)% increased Energy Shield / (6–17)% increased Stun and Block Recovery',
    );
    const fixed: PlanOption = { ...find('+# to maximum Life'), stats: [stat(LIFE, '+# to maximum Life', [5, 5])] };
    assert.equal(optionLabel(fixed), '+5 to maximum Life');
});

test("listing: the trade site's order (rank), other sources grouped at the bottom (issue #32)", () => {
    const data: SlotEditorData = {
        ...DATA,
        mods: [
            mod({ group: 'A', text: 'rare stat', rank: 200, stats: [stat('explicit.stat_a', 'rare stat', [1, 2])] }),
            mod({ group: 'B', text: 'popular stat', rank: 3, stats: [stat('explicit.stat_b', 'popular stat', [1, 2])] }),
            mod({ group: 'C', text: 'unranked stat', stats: [stat('explicit.stat_c', 'unranked stat', [1, 2])] }),
            mod({ group: 'D', text: 'bench stat', source: 'crafted', rank: 0, stats: [stat('explicit.stat_d', 'bench stat', [1, 2])] }),
            mod({ group: 'E', text: 'veiled stat', source: 'veiled', rank: 1, stats: [stat('explicit.stat_e', 'veiled stat', [1, 2])] }),
            // The same group and stat as a natural mod: one option, natural.
            mod({ group: 'B', text: 'popular stat', source: 'crafted', rank: 3, stats: [stat('explicit.stat_b', 'popular stat', [1, 2])] }),
        ],
    };
    const options: readonly PlanOption[] = planOptions(data);
    const listed: readonly string[] = listOptions(options, emptySlotPlan('Boots'), 'prefix', 'include', '', null).map((l) => l.option.text);
    assert.deepEqual(listed, ['popular stat', 'rare stat', 'unranked stat', 'bench stat', 'veiled stat']);
    assert.equal(options.find((o) => o.text === 'popular stat')?.source, 'natural');
    assert.equal(kindLabel(options.find((o) => o.text === 'bench stat') ?? assert.fail()), 'Crafted prefix');
});
