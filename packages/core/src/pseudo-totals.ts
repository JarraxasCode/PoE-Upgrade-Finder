// The site's pseudo totals an include can count with (issue #23, V27 in PLAN.md's Verification). An include on
// `explicit.stat_X` counts only lines with that stat (explicit, crafted, fractured: V24). With "count every
// source" the include filters on the pseudo total instead, which also counts implicits and the other stats that
// add to the same total: +all Attributes towards Dex, a hybrid resistance mod, half of Strength towards life.
//
// What each pseudo sums was measured live (V27, 23 Nov): every source here was seen meeting the pseudo on its
// own, with the direct stat excluded. Implicit, explicit, crafted and fractured lines all count. Left out on
// purpose: local %ES (doesn't count towards the pseudo's increased ES), "+#% to all Resistances" (not seen),
// the flat-added and %-damage pseudos (unclear or empty on the site).

/** One stat that adds to a pseudo total, by trade hash (every line kind counts), times `factor`. */
export interface PseudoSource {
    /** The trade hash, e.g. stat_3261801346 (explicit.stat_…, implicit.stat_… and crafted.stat_… all count). */
    readonly hash: string;
    readonly factor: number;
}

export interface PseudoTotal {
    /** The site's pseudo stat id, e.g. pseudo.pseudo_total_dexterity. */
    readonly id: string;
    /** The site's wording, e.g. "+# total to Dexterity". */
    readonly text: string;
    /** The explicit stats whose include can count with this total. */
    readonly forStats: readonly string[];
    readonly sources: readonly PseudoSource[];
    /** What else counts, for the editor's hint: "implicits, +all Attributes, hybrid attribute mods". */
    readonly counts: string;
}

const H = {
    fire: 'stat_3372524247',
    cold: 'stat_4220027924',
    lightning: 'stat_1671376347',
    chaos: 'stat_2923486259',
    allEle: 'stat_2901986750',
    fireCold: 'stat_2915988346',
    fireLightning: 'stat_3441501978',
    coldLightning: 'stat_4277795662',
    fireChaos: 'stat_378817135',
    coldChaos: 'stat_3393628375',
    lightningChaos: 'stat_3465022881',
    str: 'stat_4080418644',
    dex: 'stat_3261801346',
    int: 'stat_328541901',
    allAttr: 'stat_1379411836',
    strDex: 'stat_538848803',
    strInt: 'stat_1535626285',
    strIntOther: 'stat_2543977012',
    dexInt: 'stat_2300185227',
    life: 'stat_3299347043',
    mana: 'stat_1050105434',
    es: 'stat_3489782002',
    esLocal: 'stat_4052037485',
    esPercent: 'stat_2482852589',
    attackSpeed: 'stat_681332047',
    attackSpeedLocal: 'stat_210067635',
    castSpeed: 'stat_2891184298',
    movementSpeed: 'stat_2250533757',
    rarity: 'stat_3917489142',
    lifeRegen: 'stat_3325883026',
    critMulti: 'stat_3556824919',
    critChance: 'stat_587431675',
    spellDamage: 'stat_2974417149',
} as const;

function src(hash: string, factor: number = 1): PseudoSource {
    return { hash: hash, factor: factor };
}

function explicit(...hashes: readonly string[]): readonly string[] {
    return hashes.map((h: string) => `explicit.${h}`);
}

const IMPLICITS: string = 'implicits, crafted and fractured lines';
const RES: string = `${IMPLICITS}, +all Elemental Resistances and hybrid resistance mods`;
const ATTR: string = `${IMPLICITS}, +all Attributes and hybrid attribute mods`;

export const PSEUDO_TOTALS: readonly PseudoTotal[] = [
    {
        id: 'pseudo.pseudo_total_fire_resistance',
        text: '+#% total to Fire Resistance',
        forStats: explicit(H.fire),
        sources: [src(H.fire), src(H.allEle), src(H.fireCold), src(H.fireLightning), src(H.fireChaos)],
        counts: RES,
    },
    {
        id: 'pseudo.pseudo_total_cold_resistance',
        text: '+#% total to Cold Resistance',
        forStats: explicit(H.cold),
        sources: [src(H.cold), src(H.allEle), src(H.fireCold), src(H.coldLightning), src(H.coldChaos)],
        counts: RES,
    },
    {
        id: 'pseudo.pseudo_total_lightning_resistance',
        text: '+#% total to Lightning Resistance',
        forStats: explicit(H.lightning),
        sources: [src(H.lightning), src(H.allEle), src(H.fireLightning), src(H.coldLightning), src(H.lightningChaos)],
        counts: RES,
    },
    {
        id: 'pseudo.pseudo_total_chaos_resistance',
        text: '+#% total to Chaos Resistance',
        forStats: explicit(H.chaos),
        sources: [src(H.chaos), src(H.fireChaos), src(H.coldChaos), src(H.lightningChaos)],
        counts: `${IMPLICITS} and hybrid chaos resistance mods`,
    },
    {
        id: 'pseudo.pseudo_total_strength',
        text: '+# total to Strength',
        forStats: explicit(H.str),
        sources: [src(H.str), src(H.allAttr), src(H.strDex), src(H.strInt), src(H.strIntOther)],
        counts: ATTR,
    },
    {
        id: 'pseudo.pseudo_total_dexterity',
        text: '+# total to Dexterity',
        forStats: explicit(H.dex),
        sources: [src(H.dex), src(H.allAttr), src(H.strDex), src(H.dexInt)],
        counts: ATTR,
    },
    {
        id: 'pseudo.pseudo_total_intelligence',
        text: '+# total to Intelligence',
        forStats: explicit(H.int),
        sources: [src(H.int), src(H.allAttr), src(H.strInt), src(H.strIntOther), src(H.dexInt)],
        counts: ATTR,
    },
    {
        id: 'pseudo.pseudo_total_life',
        text: '+# total maximum Life',
        forStats: explicit(H.life),
        sources: [src(H.life), src(H.str, 0.5), src(H.allAttr, 0.5), src(H.strDex, 0.5), src(H.strInt, 0.5), src(H.strIntOther, 0.5)],
        counts: `${IMPLICITS}, and half of the item's Strength`,
    },
    {
        id: 'pseudo.pseudo_total_mana',
        text: '+# total maximum Mana',
        forStats: explicit(H.mana),
        sources: [src(H.mana), src(H.int, 0.5), src(H.allAttr, 0.5), src(H.strInt, 0.5), src(H.strIntOther, 0.5), src(H.dexInt, 0.5)],
        counts: `${IMPLICITS}, and half of the item's Intelligence`,
    },
    {
        id: 'pseudo.pseudo_total_energy_shield',
        text: '+# total maximum Energy Shield',
        forStats: explicit(H.es, H.esLocal),
        sources: [src(H.es), src(H.esLocal)],
        counts: `${IMPLICITS}, local and global flat Energy Shield`,
    },
    {
        id: 'pseudo.pseudo_increased_energy_shield',
        text: '#% total increased maximum Energy Shield',
        forStats: explicit(H.esPercent),
        sources: [src(H.esPercent)],
        counts: IMPLICITS,
    },
    {
        id: 'pseudo.pseudo_total_attack_speed',
        text: '+#% total Attack Speed',
        forStats: explicit(H.attackSpeed, H.attackSpeedLocal),
        sources: [src(H.attackSpeed), src(H.attackSpeedLocal)],
        counts: `${IMPLICITS}, local and global Attack Speed`,
    },
    {
        id: 'pseudo.pseudo_total_cast_speed',
        text: '+#% total Cast Speed',
        forStats: explicit(H.castSpeed),
        sources: [src(H.castSpeed)],
        counts: IMPLICITS,
    },
    {
        id: 'pseudo.pseudo_increased_movement_speed',
        text: '#% increased Movement Speed',
        forStats: explicit(H.movementSpeed),
        sources: [src(H.movementSpeed)],
        counts: IMPLICITS,
    },
    {
        id: 'pseudo.pseudo_increased_rarity',
        text: '#% increased Rarity of Items found',
        forStats: explicit(H.rarity),
        sources: [src(H.rarity)],
        counts: IMPLICITS,
    },
    {
        id: 'pseudo.pseudo_total_life_regen',
        text: '# Life Regenerated per Second',
        forStats: explicit(H.lifeRegen),
        sources: [src(H.lifeRegen)],
        counts: IMPLICITS,
    },
    {
        id: 'pseudo.pseudo_global_critical_strike_multiplier',
        text: '+#% Global Critical Strike Multiplier',
        forStats: explicit(H.critMulti),
        sources: [src(H.critMulti)],
        counts: IMPLICITS,
    },
    {
        id: 'pseudo.pseudo_global_critical_strike_chance',
        text: '+#% Global Critical Strike Chance',
        forStats: explicit(H.critChance),
        sources: [src(H.critChance)],
        counts: IMPLICITS,
    },
    {
        id: 'pseudo.pseudo_increased_spell_damage',
        text: '#% increased Spell Damage',
        forStats: explicit(H.spellDamage),
        sources: [src(H.spellDamage)],
        counts: IMPLICITS,
    },
];

const BY_STAT: ReadonlyMap<string, PseudoTotal> = new Map<string, PseudoTotal>(
    PSEUDO_TOTALS.flatMap((p: PseudoTotal) => p.forStats.map((s: string): [string, PseudoTotal] => [s, p])),
);

/** The pseudo total an include on this explicit stat can count with, if the site has one. */
export function pseudoTotalFor(statId: string): PseudoTotal | undefined {
    return BY_STAT.get(statId);
}

/** The explicit stat ids that add to a pseudo total (each also counts as implicit, crafted or fractured). */
export function pseudoSourceStats(total: PseudoTotal): readonly string[] {
    return total.sources.map((s: PseudoSource) => `explicit.${s.hash}`);
}
