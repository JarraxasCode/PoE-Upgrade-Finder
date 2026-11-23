// A small slotData result in the engine's own JSON shape (engine/lua/slotdata.lua), shared by the tests that
// need slot data: two boots bases, a plain pool each, a shared Shaper pool, a hybrid and a "reduced" mod.

function stat(id: string, text: string, line: number, range: readonly [number, number], negate: boolean = false): unknown {
    return { id: id, text: text, line: line, negate: negate, range: range };
}

export function sampleSlotDataJson(): Record<string, unknown> {
    return {
        pobVersion: '2.68.1',
        baseType: 'Boots',
        seconds: 0.4,
        bases: [
            {
                name: 'Sorcerer Boots',
                tradeType: 'Sorcerer Boots',
                subType: 'Energy Shield',
                level: 67,
                tags: ['boots', 'int_armour'],
                defences: { energyShield: [42, 51] },
                implicits: {},
                pools: { none: 0, shaper: 1 },
            },
            {
                name: 'Slink Boots',
                tradeType: 'Slink Boots',
                level: 69,
                tags: ['boots', 'dex_armour'],
                defences: { evasion: [228, 262] },
                implicits: {},
                pools: { none: 2, shaper: 1 },
            },
            {
                name: 'Two-Toned Boots (Armour/Evasion)',
                tradeType: 'Two-Toned Boots',
                level: 70,
                tags: ['boots'],
                defences: { armour: [126, 145], evasion: [126, 145] },
                implicits: [
                    {
                        modId: 'TwoTonedImplicit',
                        lines: ['+(8-12)% to Fire and Cold Resistances'],
                        stats: [stat('implicit.stat_2915988346', '+#% to Fire and Cold Resistances', 0, [8, 12])],
                    },
                ],
                pools: { none: 2 },
            },
        ],
        pools: [['ES1', 'ESSR1', 'MS1', 'MS2', 'AR1'], ['ShaperMS'], ['EV1', 'MS1', 'AR1']],
        families: [
            {
                type: 'Prefix',
                group: 'MovementVelocity',
                text: '#% increased Movement Speed',
                tradeIds: ['explicit.stat_2250533757'],
                siteTexts: ['#% increased Movement Speed'],
                tiers: ['MS1', 'MS2'],
            },
            {
                type: 'Prefix',
                group: 'LocalEnergyShieldPercent',
                text: '#% increased Energy Shield',
                tradeIds: ['explicit.stat_4015621042'],
                siteTexts: ['#% increased Energy Shield (Local)'],
                tiers: ['ES1'],
            },
            {
                type: 'Prefix',
                group: 'LocalEnergyShieldAndStunRecoveryPercent',
                text: '#% increased Energy Shield / #% increased Stun and Block Recovery',
                tradeIds: ['explicit.stat_2511217560', 'explicit.stat_4015621042'],
                siteTexts: ['#% increased Stun and Block Recovery', '#% increased Energy Shield (Local)'],
                tiers: ['ESSR1'],
            },
            {
                type: 'Suffix',
                group: 'LocalAttributeRequirements',
                text: '#% reduced Attribute Requirements',
                tradeIds: ['explicit.stat_3639275092'],
                siteTexts: ['#% increased Attribute Requirements'],
                tiers: ['AR1'],
            },
            {
                type: 'Prefix',
                group: 'LocalEvasionRatingIncreasePercent',
                text: '#% increased Evasion Rating',
                tradeIds: ['explicit.stat_124859000'],
                siteTexts: ['#% increased Evasion Rating (Local)'],
                tiers: ['EV1'],
            },
            {
                type: 'Suffix',
                group: 'MovementVelocityShaper',
                text: '#% increased Movement Speed if ...',
                tradeIds: ['explicit.stat_9'],
                siteTexts: ['x'],
                tiers: ['ShaperMS'],
            },
        ],
        mods: {
            MS1: {
                type: 'Prefix',
                family: 0,
                level: 1,
                via: 'hash',
                lines: ['10% increased Movement Speed'],
                stats: [stat('explicit.stat_2250533757', '#% increased Movement Speed', 0, [10, 10])],
            },
            MS2: {
                type: 'Prefix',
                family: 0,
                level: 86,
                via: 'hash',
                lines: ['35% increased Movement Speed'],
                stats: [stat('explicit.stat_2250533757', '#% increased Movement Speed', 0, [35, 35])],
            },
            ES1: {
                type: 'Prefix',
                family: 1,
                level: 3,
                via: 'hash',
                lines: ['(11-28)% increased Energy Shield'],
                stats: [stat('explicit.stat_4015621042', '#% increased Energy Shield (Local)', 0, [11, 28])],
            },
            ESSR1: {
                type: 'Prefix',
                family: 2,
                level: 78,
                via: 'hash',
                lines: ['(39-42)% increased Energy Shield', '(16-17)% increased Stun and Block Recovery'],
                stats: [
                    stat('explicit.stat_2511217560', '#% increased Stun and Block Recovery', 1, [16, 17]),
                    stat('explicit.stat_4015621042', '#% increased Energy Shield (Local)', 0, [39, 42]),
                ],
            },
            AR1: {
                type: 'Suffix',
                family: 3,
                level: 60,
                via: 'hash',
                lines: ['32% reduced Attribute Requirements'],
                stats: [stat('explicit.stat_3639275092', '#% increased Attribute Requirements', 0, [-32, -32], true)],
            },
            EV1: {
                type: 'Prefix',
                family: 4,
                level: 3,
                via: 'hash',
                lines: ['(15-26)% increased Evasion Rating'],
                stats: [stat('explicit.stat_124859000', '#% increased Evasion Rating (Local)', 0, [15, 26])],
            },
            ShaperMS: { type: 'Suffix', family: 5, level: 68, via: 'text', lines: ['x'], stats: {} },
        },
        unmatched: [{ modId: 'GrantsDecoyTotemSkillUber1', type: 'Suffix', lines: ['Grants Level 20 Decoy Totem'] }],
    };
}
