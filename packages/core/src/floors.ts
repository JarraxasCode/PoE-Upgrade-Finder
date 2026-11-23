// Floors, targets and flags (PLAN.md, Scoring & ranking, step 2; the PoB keys are in "Floors and targets"),
// and the hard needs that come from stripping the slot (Trade client, "Hard needs (exact rule)").
//
// Floors are minimums to clear, never targets to land on: going over is fine (PLAN, "What it judges").
//
// One rule makes the defaults safe on any build (D16, generic): a floor the build as it is already fails
// can't be held against a candidate, so it is reported as skipped rather than failing every item. It's the
// same rule the strip step uses: a floor that already fails with the current item stays soft.

import { boolean, number, record, ValidationError } from '@poe-upgrade-finder/validate';
import type { JsonRecord } from '@poe-upgrade-finder/validate';
import type { CheckResult, CheckSource, ItemCheck, RequirementSource, RunContext, SearchRequirement, SlotId } from './spec.ts';
import { ATTRIBUTES, ELEMENTS, maxRes, stat } from './stats.ts';
import type { Attribute, Element, PobStats } from './stats.ts';

/** Per build (Settings). Omitted entries are off. */
export interface FloorSettings {
    readonly chaosResMin?: number;
    readonly maxResMin?: Readonly<Partial<Record<Element, number>>>;
    readonly elementalResCapped?: boolean;
    readonly spellBlockMin?: number;
    readonly attributesMet?: boolean;
    readonly targets?: {
        readonly chaosRes?: number;
        readonly maxRes?: Readonly<Partial<Record<Element, number>>>;
        /** Overcap wanted per element. */
        readonly overcapMin?: number;
    };
    /** Life loss is flagged on every slot except the weapons. */
    readonly flagLifeLoss?: boolean;
    /** Net life regen turning negative, on builds with a degen (NetLifeRegen present). */
    readonly flagNetRegen?: boolean;
}

/** PLAN.md's values. Thanks to the skip rule they only bite where the build already meets them. */
export const DEFAULT_FLOORS: FloorSettings = {
    chaosResMin: 50,
    maxResMin: { Fire: 88 },
    elementalResCapped: true,
    spellBlockMin: 75,
    attributesMet: true,
    targets: { chaosRes: 75, maxRes: { Fire: 90 }, overcapMin: 10 },
    flagLifeLoss: true,
    flagNetRegen: true,
};

function readPerElement(value: unknown, path: string): Partial<Record<Element, number>> {
    const r: JsonRecord = record(value, path);
    const out: Partial<Record<Element, number>> = {};
    for (const [key, v] of Object.entries(r)) {
        const el: Element | undefined = ELEMENTS.find((e: Element) => e === key);
        if (el === undefined) {
            throw new ValidationError(`${path}.${key}: not an element (Fire, Cold, Lightning)`);
        }
        out[el] = number(v, `${path}.${key}`);
    }
    return out;
}

/**
 * Per-build floor settings from JSON (Settings, or the headless mode's --floors file), on top of the
 * defaults. Each field is checked; null turns a default off; unknown fields are errors.
 */
export function readFloorSettings(value: unknown, base: FloorSettings = DEFAULT_FLOORS): FloorSettings {
    const r: JsonRecord = record(value, 'floors');
    const out: { -readonly [K in keyof FloorSettings]: FloorSettings[K] } = { ...base };
    for (const [key, v] of Object.entries(r)) {
        const path: string = `floors.${key}`;
        switch (key) {
            case 'chaosResMin':
            case 'spellBlockMin':
            case 'elementalResCapped':
            case 'attributesMet':
            case 'flagLifeLoss':
            case 'flagNetRegen':
            case 'maxResMin':
            case 'targets':
                if (v === null) {
                    delete out[key];
                    continue;
                }
                break;
            default:
                throw new ValidationError(`${path}: unknown floor setting`);
        }
        switch (key) {
            case 'chaosResMin':
            case 'spellBlockMin':
                out[key] = number(v, path);
                break;
            case 'elementalResCapped':
            case 'attributesMet':
            case 'flagLifeLoss':
            case 'flagNetRegen':
                out[key] = boolean(v, path);
                break;
            case 'maxResMin':
                out[key] = readPerElement(v, path);
                break;
            case 'targets': {
                const t: JsonRecord = record(v, path);
                const targets: { chaosRes?: number; maxRes?: Partial<Record<Element, number>>; overcapMin?: number } = {};
                for (const [tk, tv] of Object.entries(t)) {
                    if (tv === null) {
                        continue;
                    }
                    if (tk === 'chaosRes' || tk === 'overcapMin') {
                        targets[tk] = number(tv, `${path}.${tk}`);
                    } else if (tk === 'maxRes') {
                        targets.maxRes = readPerElement(tv, `${path}.maxRes`);
                    } else {
                        throw new ValidationError(`${path}.${tk}: unknown target (chaosRes, maxRes, overcapMin)`);
                    }
                }
                out[key] = targets;
                break;
            }
        }
    }
    return out;
}

const ATTRIBUTE_NAMES: Readonly<Record<Attribute, string>> = { Str: 'strength', Dex: 'dexterity', Int: 'intelligence' };
const WEAPON_SLOTS: ReadonlySet<SlotId> = new Set<SlotId>(['Weapon 1', 'Weapon 2']);

function fmt(value: number | undefined): string {
    if (value === undefined) {
        return '?';
    }
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A "value ≥ threshold" check on one reading of PoB's output. */
function minCheck(
    id: string,
    kind: 'floor' | 'target',
    label: string,
    read: (s: PobStats) => number | undefined,
    threshold: (s: PobStats) => number | undefined,
): ItemCheck {
    return {
        id: id,
        kind: kind,
        label: label,
        evaluate(before: PobStats, after: PobStats): CheckResult {
            const value: number | undefined = read(after);
            const need: number | undefined = threshold(after);
            const was: number | undefined = read(before);
            const wasNeed: number | undefined = threshold(before);
            const detail: string = `${label}: ${fmt(value)} (was ${fmt(was)})`;
            if (value === undefined || need === undefined) {
                return { checkId: id, kind: kind, status: 'skipped', detail: `${label}: PoB has no value` };
            }
            if (kind === 'floor' && (was === undefined || wasNeed === undefined || was < wasNeed)) {
                return { checkId: id, kind: kind, status: 'skipped', detail: `${detail}; the build is already below it` };
            }
            return { checkId: id, kind: kind, status: value >= need ? 'pass' : 'fail', detail: detail };
        },
    };
}

function constant(n: number): () => number {
    return (): number => n;
}

export function floorChecks(settings: FloorSettings, slot: SlotId): ItemCheck[] {
    const checks: ItemCheck[] = [];
    if (settings.chaosResMin !== undefined) {
        checks.push(
            minCheck(
                'chaos-res',
                'floor',
                `Chaos res ≥ ${settings.chaosResMin}`,
                (s: PobStats) => stat(s, 'ChaosResist'),
                constant(settings.chaosResMin),
            ),
        );
    }
    for (const el of ELEMENTS) {
        const min: number | undefined = settings.maxResMin?.[el];
        if (min !== undefined) {
            checks.push(
                minCheck(
                    `max-res-${el.toLowerCase()}`,
                    'floor',
                    `Max ${el.toLowerCase()} res ≥ ${min}`,
                    (s: PobStats) => maxRes(s, el),
                    constant(min),
                ),
            );
        }
    }
    if (settings.elementalResCapped === true) {
        for (const el of ELEMENTS) {
            // Capped means Missing<El>Resist = 0, i.e. final res ≥ max res.
            checks.push(
                minCheck(
                    `res-capped-${el.toLowerCase()}`,
                    'floor',
                    `${el} res capped`,
                    (s: PobStats) => stat(s, `${el}Resist`),
                    (s: PobStats) => maxRes(s, el),
                ),
            );
        }
    }
    if (settings.spellBlockMin !== undefined) {
        checks.push(
            minCheck(
                'spell-block',
                'floor',
                `Spell block ≥ ${settings.spellBlockMin}`,
                (s: PobStats) => stat(s, 'SpellBlockChance'),
                constant(settings.spellBlockMin),
            ),
        );
    }
    if (settings.attributesMet === true) {
        for (const a of ATTRIBUTES) {
            checks.push(
                minCheck(
                    `attr-${a.toLowerCase()}`,
                    'floor',
                    `${a} requirement met`,
                    (s: PobStats) => stat(s, a),
                    (s: PobStats) => stat(s, `Req${a}`) ?? 0,
                ),
            );
        }
    }
    const t: FloorSettings['targets'] = settings.targets;
    if (t?.chaosRes !== undefined) {
        checks.push(
            minCheck(
                'target-chaos-res',
                'target',
                `Chaos res ${t.chaosRes}`,
                (s: PobStats) => stat(s, 'ChaosResist'),
                constant(t.chaosRes),
            ),
        );
    }
    for (const el of ELEMENTS) {
        const target: number | undefined = t?.maxRes?.[el];
        if (target !== undefined) {
            checks.push(
                minCheck(
                    `target-max-res-${el.toLowerCase()}`,
                    'target',
                    `Max ${el.toLowerCase()} res ${target}`,
                    (s: PobStats) => maxRes(s, el),
                    constant(target),
                ),
            );
        }
    }
    if (t?.overcapMin !== undefined) {
        for (const el of ELEMENTS) {
            checks.push(
                minCheck(
                    `target-overcap-${el.toLowerCase()}`,
                    'target',
                    `${el} overcap ≥ ${t.overcapMin}`,
                    (s: PobStats) => stat(s, `${el}ResistOverCap`),
                    constant(t.overcapMin),
                ),
            );
        }
    }
    if (settings.flagLifeLoss === true && !WEAPON_SLOTS.has(slot)) {
        checks.push(lifeLossFlag());
    }
    if (settings.flagNetRegen === true) {
        checks.push(netRegenFlag());
    }
    return checks;
}

function lifeLossFlag(): ItemCheck {
    return {
        id: 'life-loss',
        kind: 'flag',
        label: 'Life loss',
        evaluate(before: PobStats, after: PobStats): CheckResult {
            const was: number | undefined = stat(before, 'Life');
            const now: number | undefined = stat(after, 'Life');
            if (was === undefined || now === undefined) {
                return { checkId: 'life-loss', kind: 'flag', status: 'skipped', detail: 'Life: PoB has no value' };
            }
            // A flag "fails" when it is raised.
            return {
                checkId: 'life-loss',
                kind: 'flag',
                status: now < was ? 'fail' : 'pass',
                detail: `Life ${fmt(now)} (was ${fmt(was)})`,
            };
        },
    };
}

function netRegenFlag(): ItemCheck {
    return {
        id: 'net-regen',
        kind: 'flag',
        label: 'Net life regen negative',
        evaluate(_before: PobStats, after: PobStats): CheckResult {
            const net: number | undefined = stat(after, 'NetLifeRegen');
            if (net === undefined) {
                return { checkId: 'net-regen', kind: 'flag', status: 'skipped', detail: 'No degen on this build' };
            }
            return { checkId: 'net-regen', kind: 'flag', status: net < 0 ? 'fail' : 'pass', detail: `Net life regen ${fmt(net)}/s` };
        },
    };
}

/** v1's check source: the build's floors, targets and flags (v2 adds per-slot floors). */
export const buildFloors: CheckSource = {
    id: 'build-floors',
    checksFor(context: RunContext): readonly ItemCheck[] {
        return floorChecks(context.floors, context.slot);
    },
};

// Hard needs ---------------------------------------------------------------------------------------------

const RES_STAT: Readonly<Record<Element | 'Chaos', string>> = {
    Fire: 'pseudo.pseudo_total_fire_resistance',
    Cold: 'pseudo.pseudo_total_cold_resistance',
    Lightning: 'pseudo.pseudo_total_lightning_resistance',
    Chaos: 'pseudo.pseudo_total_chaos_resistance',
};

function need(statId: string, min: number, label: string): SearchRequirement {
    return { statId: statId, min: Math.ceil(min), origin: 'strip', label: `Required: ${label} ≥ ${Math.ceil(min)}, from strip` };
}

/**
 * A floor that passes with the current item and fails after the strip becomes a required (And) filter with
 * min = floor − value after strip, from PoB's uncapped totals. Always achievable: the current item supplied
 * at least that much. A floor already failing stays soft (its stat stays in the weighted group).
 *
 * Covered: chaos res, each elemental res at its cap, attributes (all have pseudo totals on the site). Not
 * covered: spell block (no pseudo total; the floor check after the swap still applies) and max res (not a
 * hard need in PLAN).
 */
export function stripNeeds(settings: FloorSettings, baseline: PobStats, stripped: PobStats): SearchRequirement[] {
    const needs: SearchRequirement[] = [];
    if (settings.chaosResMin !== undefined) {
        const before: number | undefined = stat(baseline, 'ChaosResist');
        const after: number | undefined = stat(stripped, 'ChaosResist');
        const total: number | undefined = stat(stripped, 'ChaosResistTotal');
        if (
            before !== undefined &&
            after !== undefined &&
            total !== undefined &&
            before >= settings.chaosResMin &&
            after < settings.chaosResMin
        ) {
            needs.push(need(RES_STAT.Chaos, settings.chaosResMin - total, 'chaos res'));
        }
    }
    if (settings.elementalResCapped === true) {
        for (const el of ELEMENTS) {
            const missingBefore: number | undefined = stat(baseline, `Missing${el}Resist`);
            const missingAfter: number | undefined = stat(stripped, `Missing${el}Resist`);
            const max: number | undefined = maxRes(stripped, el);
            const total: number | undefined = stat(stripped, `${el}ResistTotal`);
            if (missingBefore === 0 && missingAfter !== undefined && missingAfter > 0 && max !== undefined && total !== undefined) {
                needs.push(need(RES_STAT[el], max - total, `${el.toLowerCase()} res`));
            }
        }
    }
    if (settings.attributesMet === true) {
        for (const a of ATTRIBUTES) {
            const hadBefore: number | undefined = stat(baseline, a);
            const reqBefore: number = stat(baseline, `Req${a}`) ?? 0;
            const hasAfter: number | undefined = stat(stripped, a);
            const reqAfter: number = stat(stripped, `Req${a}`) ?? 0;
            if (hadBefore !== undefined && hasAfter !== undefined && hadBefore >= reqBefore && hasAfter < reqAfter) {
                needs.push(need(`pseudo.pseudo_total_${ATTRIBUTE_NAMES[a]}`, reqAfter - hasAfter, ATTRIBUTE_NAMES[a]));
            }
        }
    }
    return needs;
}

/** v1's requirement source (v2 adds the user's). */
export const stripNeedsSource: RequirementSource = {
    id: 'strip-needs',
    requirementsFor(context: RunContext): readonly SearchRequirement[] {
        return stripNeeds(context.floors, context.baseline, context.stripped);
    },
};
