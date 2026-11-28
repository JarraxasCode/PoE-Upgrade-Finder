// One slot plan → one slot search spec (PLAN.md, "v2a: the slot plan"): a pure function of the plan and the
// build's PoB data, with no run state, so the multi-slot batch (v0.4) calls it once per plan.
//
// The one way a spec is built: the build's sources (the strip's hard needs, PoB's weights, the floors) and
// the plan's. The plan's includes become requirements, its pure excludes a Not group and its hybrid excludes mod
// exclusions (checked after the fetch, #38), its base the query's `type`,
// its item type the category, its influenced includes the influence filters, and it prunes PoB's weights
// (after the user's weight review). An empty plan adds nothing: v0.1's spec.

import type { SlotData, UniqueInfo } from '@poe-upgrade-finder/engine-client';
import { categoryOf, DEFENCE_NAMES, isUniquePlan, SOCKET_ROWS, socketRowText } from '@poe-upgrade-finder/vocab';
import type { DefenceRange, ModPick, PickedUnique, PickStat, PlanTotal, SlotPlan, SocketRange } from '@poe-upgrade-finder/vocab';
import { buildFloors, stripNeedsSource } from './floors.ts';
import { analysePlan, isHybridExclude, notGroupExcludes, planDefences, planTotals } from './plan.ts';
import { PSEUDO_TOTALS } from './pseudo-totals.ts';
import type { PseudoTotal } from './pseudo-totals.ts';
import type { AnalysedPlan, PickSource, PickStatInfo, PlanCheck, PlanGear, PlanSlotData } from './plan.ts';
import { composeSpec, pobWeights } from './spec.ts';
import { UniqueSource } from './unique-source.ts';
import type {
    RunContext,
    SearchDefence,
    SearchExclusion,
    SearchModExclusion,
    SearchRequirement,
    SearchSockets,
    SlotSearchSpec,
    SpecContribution,
    SpecSource,
    WeightedStat,
} from './spec.ts';

/** The plan's socket filters (#58), rows with any field set, in the site's order; for rare and unique plans alike. */
export function socketFilters(plan: SlotPlan): readonly SearchSockets[] {
    const out: SearchSockets[] = [];
    for (const row of SOCKET_ROWS) {
        const range: SocketRange | undefined = plan.sockets?.[row];
        if (range !== undefined && Object.keys(range).length > 0) {
            out.push({ row: row, range: range, origin: 'plan', label: `${socketRowText(row, range)}, from plan` });
        }
    }
    return out;
}

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
 * each stat), excludes → exclusions, defences → the armour filters, influenced includes → influences, the base →
 * the site's `type`, the item type → the category, and the pruning of the weights. From an analysed, accepted plan.
 */
export class PlanSource implements SpecSource {
    public readonly id: string = 'slot-plan';
    private readonly analysed: AnalysedPlan;
    private readonly plan: SlotPlan;
    private readonly view: PlanSlotData | undefined;

    /** From the analysed plan: the plan as it will be searched, and its bases. */
    public constructor(analysed: AnalysedPlan) {
        this.analysed = analysed;
        this.plan = analysed.check.plan;
        this.view = analysed.view;
    }

    public contribute(_context: RunContext): SpecContribution {
        const category: string | undefined = this.plan.itemType === null ? undefined : categoryOf(this.plan.itemType);
        const baseType: string | null = this.baseType();
        return {
            requirements: this.requirements(),
            exclusions: this.exclusions(),
            modExclusions: this.modExclusions(),
            defences: this.defences(),
            sockets: socketFilters(this.plan),
            influences: this.analysed.check.influences,
            // The plan's item type picks the category (every base of the type); none keeps PoB's.
            ...(category === undefined ? {} : { category: category }),
            ...(baseType === null ? {} : { baseType: baseType }),
            prune: (weights: readonly WeightedStat[]) => this.analysed.prune(weights),
        };
    }

    private requirements(): readonly SearchRequirement[] {
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

    private exclusions(): readonly SearchExclusion[] {
        const out: SearchExclusion[] = [];
        const seen: Set<string> = new Set<string>();
        for (const pick of notGroupExcludes(this.plan.picks)) {
            for (const s of pick.stats) {
                if (!seen.has(s.statId)) {
                    seen.add(s.statId);
                    out.push({ statId: s.statId, origin: 'plan', label: `Excluded: ${this.info(pick, s.statId).text}, from plan` });
                }
            }
        }
        return out;
    }

    /** The hybrid excludes (#38), each named as the mod: the editor's family text. */
    private modExclusions(): readonly SearchModExclusion[] {
        return this.plan.picks.filter(isHybridExclude).map((pick: ModPick): SearchModExclusion => {
            const source: PickSource | undefined = this.view?.sourceOf(pick);
            const name: string =
                source?.kind === 'family'
                    ? source.ref.family.text
                    : pick.stats.map((s: PickStat) => this.info(pick, s.statId).text).join(' / ');
            return {
                statIds: pick.stats.map((s: PickStat) => s.statId),
                name: name,
                origin: 'plan',
                label: `Excluded: ${name} (hybrid mod), from plan`,
            };
        });
    }

    /** The plan's defence ranges (issue #24), as the site's armour filters take them. */
    private defences(): readonly SearchDefence[] {
        return planDefences(this.plan).map(([kind, range]: readonly [SearchDefence['defence'], DefenceRange]) => ({
            defence: kind,
            ...(range.min === undefined ? {} : { min: range.min }),
            ...(range.max === undefined ? {} : { max: range.max }),
            origin: 'plan',
            label: `${DEFENCE_NAMES[kind]}${rangeText(range)}, from plan`,
        }));
    }

    /** The site's name for the plan's base (all its bracketed variants), or null for any base. */
    private baseType(): string | null {
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
    /** The build's weapons, for the weapon-hand rules (#39); missing: not checked. */
    readonly gear?: PlanGear;
    /** PoB's data for the plan's unique (engine `uniques`); needed for a unique search (#113). */
    readonly unique?: UniqueInfo;
}

export type SlotSpecResult =
    { readonly ok: true; readonly spec: SlotSearchSpec; readonly check: PlanCheck } | { readonly ok: false; readonly check: PlanCheck };

/** The build's own sources, before any plan: the strip's hard needs, PoB's weights, the floors. */
export const BUILD_SOURCES: readonly SpecSource[] = [stripNeedsSource, pobWeights, buildFloors];

/**
 * The spec for one slot plan: checked (a refused plan gives its problems and no spec), then the build's sources
 * and the plan's, composed.
 */
export function buildSlotSpec(plan: SlotPlan, build: PlanBuildData): SlotSpecResult {
    if (isUniquePlan(plan)) {
        return uniqueSlotSpec(plan, build);
    }
    const analysed: AnalysedPlan = analysePlan(plan, build.context.slot, build.slotData, build.gear);
    const check: PlanCheck = analysed.check;
    if (!check.ok) {
        return { ok: false, check: check };
    }
    const spec: SlotSearchSpec = composeSpec(build.context, [...BUILD_SOURCES, new PlanSource(analysed)]);
    return { ok: true, check: check, spec: spec };
}

/**
 * A unique search (#113): the strip's hard needs and the floors, and the unique's own weights in place of PoB's
 * generator and the slot plan. The weight review's edits are for PoB's rare weights, so they don't apply.
 */
function uniqueSlotSpec(plan: SlotPlan & { readonly unique: PickedUnique }, build: PlanBuildData): SlotSpecResult {
    const unique: UniqueInfo | undefined = build.unique;
    const itemType: string | null = plan.itemType;
    if (unique === undefined || unique.name !== plan.unique.name || unique.base !== plan.unique.base || itemType === null) {
        const problem = { code: 'unknown-unique' as const, pick: undefined, text: `PoB doesn't know that unique (${plan.unique.name})` };
        const check: PlanCheck = { ok: false, plan: plan, problems: [problem], notes: [], influences: [] };
        return { ok: false, check: check };
    }
    const context: RunContext = { ...build.context, weightEdits: undefined };
    const sockets: SpecSource = { id: 'sockets', contribute: () => ({ sockets: socketFilters(plan) }) };
    const spec: SlotSearchSpec = composeSpec(context, [stripNeedsSource, buildFloors, new UniqueSource(unique, itemType), sockets]);
    return { ok: true, spec: spec, check: { ok: true, plan: plan, problems: [], notes: [], influences: [] } };
}
