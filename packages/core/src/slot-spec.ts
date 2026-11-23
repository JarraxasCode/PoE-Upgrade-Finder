// One slot plan → one slot search spec (PLAN.md, "v2a: the slot plan"): a pure function of the plan and the
// build's PoB data, with no run state, so the multi-slot batch (v0.4) calls it once per plan.
//
// The plan adds to v1's spec: its includes become requirements (beside the strip's hard needs), its
// excludes a Not group, its base the query's `type`, its influenced includes the influence filters. PoB's
// weights (after the user's weight review) are then pruned by the plan. An empty plan gives v0.1's spec.

import type { SlotData, SlotInfluence } from '@poe-upgrade-finder/engine-client';
import { buildFloors, stripNeedsSource } from './floors.ts';
import { categoryOf } from './item-types.ts';
import { checkPlan, DEFENCE_NAMES, planDefences, PlanSlotData, planTotals, pruneWeights } from './plan.ts';
import { PSEUDO_TOTALS } from './pseudo-totals.ts';
import type { PseudoTotal } from './pseudo-totals.ts';
import type { DefenceRange, ModPick, PickStat, PickStatInfo, PlanCheck, PlanTotal, SlotPlan } from './plan.ts';
import { pobWeights, SpecBuilder } from './spec.ts';
import type { RequirementSource, RunContext, SearchDefence, SearchExclusion, SearchRequirement, SlotSearchSpec } from './spec.ts';

/** "(20 to 30)", "(≥ 20)", "(≤ 30)" or "" in the mod's own terms. */
function rangeText(s: { readonly min?: number; readonly max?: number }): string {
    if (s.min !== undefined && s.max !== undefined) {
        return s.min === s.max ? ` (${s.min})` : ` (${s.min} to ${s.max})`;
    }
    if (s.min !== undefined) {
        return ` (≥ ${s.min})`;
    }
    if (s.max !== undefined) {
        return ` (≤ ${s.max})`;
    }
    return '';
}

/**
 * The plan's include as the site wants it. A stat worded the opposite way to the site's ("reduced" against
 * "increased", V24 decision 11) is negated and swapped: reduced 20 to 32 → { min: -32, max: -20 }.
 */
export function siteRange(s: PickStat, negate: boolean): { readonly min?: number; readonly max?: number } {
    const lo: number | undefined = negate ? (s.max === undefined ? undefined : -s.max) : s.min;
    const hi: number | undefined = negate ? (s.min === undefined ? undefined : -s.min) : s.max;
    return { ...(lo === undefined ? {} : { min: lo }), ...(hi === undefined ? {} : { max: hi }) };
}

function totalRange(t: PlanTotal): { readonly min?: number; readonly max?: number } {
    return { ...(t.min === undefined ? {} : { min: t.min }), ...(t.max === undefined ? {} : { max: t.max }) };
}

/**
 * The slot plan's source for the spec: includes → requirements (with their ranges, on the item's total for
 * each stat), excludes → exclusions, the base → the site's `type`. Built from a checked plan.
 */
export class PlanRequirements implements RequirementSource {
    public readonly id: string = 'slot-plan';
    private readonly plan: SlotPlan;
    private readonly view: PlanSlotData | undefined;

    public constructor(plan: SlotPlan, data: SlotData | undefined) {
        this.plan = plan;
        this.view = data === undefined ? undefined : new PlanSlotData(data, plan.base);
    }

    public requirementsFor(_context: RunContext): readonly SearchRequirement[] {
        const out: SearchRequirement[] = [];
        for (const pick of this.picks('include')) {
            for (const s of pick.stats) {
                const info: PickStatInfo = this.info(pick, s.statId);
                const siteText: string | undefined = this.view?.siteText(s.statId);
                out.push({
                    statId: s.statId,
                    ...siteRange(s, info.negate),
                    origin: 'plan',
                    label: `Required: ${info.text}${rangeText(s)}, from plan`,
                    ...(siteText === undefined || siteText === s.statId ? {} : { siteText: siteText }),
                    ...(info.negate ? { negated: true } : {}),
                });
            }
        }
        // The totals (issue #26): from any source. None of the site's pseudo totals is worded the other way round.
        for (const t of planTotals(this.plan)) {
            const known: PseudoTotal | undefined = PSEUDO_TOTALS.find((p: PseudoTotal) => p.id === t.statId);
            out.push({
                statId: t.statId,
                ...totalRange(t),
                origin: 'plan',
                label: `Required: ${t.text}${rangeText(t)}${known === undefined ? '' : ` (counts ${known.counts})`}, from plan`,
            });
        }
        return out;
    }

    public exclusions(): readonly SearchExclusion[] {
        const out: SearchExclusion[] = [];
        const seen: Set<string> = new Set<string>();
        for (const pick of this.picks('exclude')) {
            for (const s of pick.stats) {
                if (!seen.has(s.statId)) {
                    seen.add(s.statId);
                    out.push({ statId: s.statId, origin: 'plan', label: `Excluded: ${this.info(pick, s.statId).text}, from plan` });
                }
            }
        }
        return out;
    }

    /** The plan's defence ranges (issue #24), as the site's armour filters take them. */
    public defences(): readonly SearchDefence[] {
        return planDefences(this.plan).map(([kind, range]: readonly [SearchDefence['defence'], DefenceRange]) => ({
            defence: kind,
            ...(range.min === undefined ? {} : { min: range.min }),
            ...(range.max === undefined ? {} : { max: range.max }),
            origin: 'plan',
            label: `${DEFENCE_NAMES[kind]}${rangeText(range)}, from plan`,
        }));
    }

    /** The site's name for the plan's base (all its bracketed variants), or null for any base. */
    public baseType(): string | null {
        if (this.plan.base === null) {
            return null;
        }
        return this.view?.bases[0]?.tradeType ?? this.plan.base;
    }

    private picks(rule: ModPick['rule']): readonly ModPick[] {
        return this.plan.picks.filter((p: ModPick) => p.rule === rule);
    }

    private info(pick: ModPick, statId: string): PickStatInfo {
        return this.view?.statInfo(pick, statId) ?? { text: statId, negate: false };
    }
}

/** Everything buildSlotSpec reads about the build: the run's context (PoB's numbers and weights) and the slot data. */
export interface PlanBuildData {
    readonly context: RunContext;
    /** The slot data for the plan's item type; may be undefined for an empty plan. */
    readonly slotData: SlotData | undefined;
}

export type SlotSpecResult =
    { readonly ok: true; readonly spec: SlotSearchSpec; readonly check: PlanCheck } | { readonly ok: false; readonly check: PlanCheck };

/**
 * The spec for one slot plan: checked (a refused plan gives its problems and no spec), then v1's sources
 * plus the plan's, then the plan's pruning of the weights.
 */
export function buildSlotSpec(plan: SlotPlan, build: PlanBuildData): SlotSpecResult {
    const check: PlanCheck = checkPlan(plan, build.context.slot, build.slotData);
    if (!check.ok) {
        return { ok: false, check: check };
    }
    const source: PlanRequirements = new PlanRequirements(check.plan, build.slotData);
    const builder: SpecBuilder = new SpecBuilder({
        requirements: [stripNeedsSource, source],
        weights: [pobWeights],
        checks: [buildFloors],
        noters: [],
    });
    const spec: SlotSearchSpec = builder.build(build.context);
    // Prune against the plan as the user set it, so a redundant exclude's weight still reads "excluded".
    const { kept, pruned } = pruneWeights(spec.weights, plan, build.context.slot, build.slotData);
    const influences: readonly SlotInfluence[] = check.influences;
    return {
        ok: true,
        check: check,
        spec: {
            ...spec,
            // The plan's item type picks the category (every base of the type); none keeps PoB's.
            category: (check.plan.itemType === null ? undefined : categoryOf(check.plan.itemType)) ?? spec.category,
            baseType: source.baseType(),
            exclusions: source.exclusions(),
            defences: source.defences(),
            influences: influences,
            weights: kept,
            pruned: pruned,
        },
    };
}
