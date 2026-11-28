// Core's run results → the Run view's types (packages/ipc). Pure, so it is unit-tested. Seller names stay
// in main: the UI only learns whether an item has a buy link.

import { buyLink, isEmptyPlan } from '@poe-upgrade-finder/core';
import type {
    CheckResult,
    DefenceMatch,
    EvaluatedItem,
    ExclusionMatch,
    FilteredItem,
    MatchedLine,
    PlanMatch,
    PobStats,
    PriceBand,
    RequirementMatch,
    RunResult,
    SearchRecord,
    SearchRequirement,
    SearchSockets,
    SlotSearchSpec,
    SocketMatch,
} from '@poe-upgrade-finder/core';
import { statChanges } from './stat-changes.ts';
import type {
    LimitPanel,
    LimitPolicy,
    RunSummaryUi,
    UiBand,
    UiItem,
    UiPlanCheck,
    UiPlanLine,
    UiPlanRule,
    UiRunPlan,
    UiSearch,
} from '@poe-upgrade-finder/ipc';
import type { PolicySnapshot, TradePolicy } from '@poe-upgrade-finder/trade';
import type { LevelFilter, SlotInfluence, SlotPlan } from '@poe-upgrade-finder/vocab';

function pct(n: number): number | null {
    return Number.isFinite(n) ? n : null;
}

const details = (checks: readonly CheckResult[]): string[] => checks.map((c: CheckResult) => c.detail);

/** A spec label for the Run view: "Required: X (≥ 30) (counts Y), from plan" → { label: "X (≥ 30)", counts: "Y" }. */
export function planRule(specLabel: string): UiPlanRule {
    const s: string = specLabel.replace(/^(?:Required|Excluded): /, '').replace(/, from (?:plan|strip)$/, '');
    const m: RegExpExecArray | null = /^(.*) \(counts (.*)\)$/.exec(s);
    return m === null ? { label: s, counts: null } : { label: m[1] ?? s, counts: m[2] ?? null };
}

/** 34 → "34", 32.5 → "32.5". */
function num(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function planLine(l: MatchedLine): UiPlanLine {
    const notes: string[] = [];
    if (l.kind !== 'explicit') {
        notes.push(l.kind);
    }
    if (l.factor !== 1) {
        notes.push(l.factor === 0.5 ? 'half' : `× ${l.factor}`);
    }
    return { text: l.text, note: notes.join(', ') };
}

function requirementCheck(r: RequirementMatch): UiPlanCheck {
    return {
        kind: r.origin === 'plan' ? 'include' : 'need',
        label: planRule(r.label).label,
        status: r.status,
        value: r.total === null ? null : `total ${num(r.total)}`,
        lines: r.lines.map(planLine),
    };
}

function exclusionCheck(e: ExclusionMatch): UiPlanCheck {
    return { kind: 'exclude', label: planRule(e.label).label, status: e.status, value: null, lines: e.lines.map(planLine) };
}

/**
 * A defence's value as the site compares it (decision 19): an item below 20% quality is raised to 20%, so a
 * 0%-quality item listed at 418 Armour reads "418 listed at 0% quality, 502 at 20%" and passes a min of 500.
 */
export function defenceValue(d: Pick<DefenceMatch, 'listed' | 'quality' | 'compared'>): string | null {
    if (d.listed === null || d.compared === null) {
        return null;
    }
    if (d.listed === 0) {
        return 'none on the item';
    }
    if (d.listed > 0 && d.quality < 20) {
        return `${d.listed} listed at ${d.quality}% quality, ${Math.round(d.compared)} at 20%`;
    }
    return d.quality > 0 ? `${d.listed} at ${d.quality}% quality` : String(d.listed);
}

function defenceCheck(d: DefenceMatch): UiPlanCheck {
    return { kind: 'defence', label: planRule(d.label).label, status: d.status, value: defenceValue(d), lines: [] };
}

function socketCheck(s: SocketMatch): UiPlanCheck {
    return { kind: 'socket', label: planRule(s.label).label, status: s.status, value: s.value, lines: [] };
}

/** A hard need for the run header: "chaos res ≥ 22", and the gap it came from when it was capped (#34). */
export function hardNeedText(r: SearchRequirement): string {
    const text: string = r.label.replace(/^Required: /, '').replace(/, from strip$/, '');
    return r.gap === undefined
        ? text
        : `${text} (without this item the build is ${r.gap} short of the floor, more than the item carries itself)`;
}

/** The site's names for PoB's influence keys. */
const INFLUENCE_NAMES: Readonly<Record<SlotInfluence, string>> = {
    none: 'no',
    shaper: 'Shaper',
    elder: 'Elder',
    adjudicator: 'Warlord',
    basilisk: 'Hunter',
    crusader: 'Crusader',
    eyrie: 'Redeemer',
};

/**
 * What narrowed a run's search, for the verdict when no listing in budget matched (#34): the build's hard needs,
 * the plan's includes, defences and socket filters, the base, influences, the unique and the level filter (not instant buyout: whisper listings are the user's own choice). Read
 * from the spec, so it costs no trade calls; it can't say which one emptied the search.
 */
export function emptyRunCauses(spec: SlotSearchSpec): string[] {
    const causes: string[] = [
        ...spec.requirements.filter((r) => r.origin === 'strip').map((r) => `${hardNeedText(r)}, from a floor in Settings`),
        ...spec.requirements.filter((r) => r.origin === 'plan').map((r) => planRule(r.label).label),
        ...spec.defences.map((d) => planRule(d.label).label),
        ...socketLabels(spec.sockets),
    ];
    if (spec.baseType !== null && spec.unique === null) {
        causes.push(`base ${spec.baseType}`);
    }
    if (spec.influences.length > 0) {
        causes.push(`${spec.influences.map((i: SlotInfluence) => INFLUENCE_NAMES[i]).join(' and ')} influence`);
    }
    if (spec.unique !== null) {
        causes.push(`the unique ${spec.unique.name}`);
    }
    if (spec.maxLevelRequirement !== undefined) {
        causes.push(`up to level ${spec.maxLevelRequirement}`);
    }
    return causes;
}

/** The socket filters (#58) for the run header: "Links ≥ 6". */
export function socketLabels(sockets: readonly SearchSockets[]): string[] {
    return sockets.map((s: SearchSockets) => planRule(s.label).label);
}

/** The plan's includes first, then the build's hard needs, the excludes, the defences and the socket filters. */
export function planChecks(m: PlanMatch): UiPlanCheck[] {
    const requirements: UiPlanCheck[] = m.requirements.map(requirementCheck);
    return [
        ...requirements.filter((c: UiPlanCheck) => c.kind === 'include'),
        ...requirements.filter((c: UiPlanCheck) => c.kind === 'need'),
        ...m.exclusions.map(exclusionCheck),
        ...m.defences.map(defenceCheck),
        ...m.sockets.map(socketCheck),
    ];
}

/** The Run header's view of the slot plan; null for an empty plan (searched as v0.1). */
export function toUiRunPlan(plan: SlotPlan, spec: SlotSearchSpec, notes: readonly string[]): UiRunPlan | null {
    if (isEmptyPlan(plan)) {
        return null;
    }
    return {
        itemType: plan.itemType,
        base: spec.baseType,
        includes: spec.requirements.filter((r) => r.origin === 'plan').map((r) => planRule(r.label)),
        excludes: [...spec.exclusions, ...spec.modExclusions].map((e) => planRule(e.label).label),
        defences: spec.defences.map((d) => planRule(d.label).label),
        influences: [...spec.influences],
        pruned: spec.pruned.length,
        notes: [...notes],
    };
}

/** The level requirement filter as searched (issue #22). */
export function levelFilterLabel(filter: LevelFilter, maxLevel: number | undefined): string {
    switch (filter.kind) {
        case 'off':
            return 'Any level';
        case 'max':
            return `Up to level ${filter.level}`;
        case 'character':
            return maxLevel === undefined ? 'Up to your level' : `Up to level ${maxLevel} (your level)`;
    }
}

export function toUiItem(e: EvaluatedItem, league: string, baseline: PobStats, filtered?: FilteredItem): UiItem {
    const i = e.item;
    return {
        id: i.id,
        name: i.name,
        baseType: i.baseType,
        itemLevel: i.itemLevel ?? null,
        price: i.price === undefined ? null : { amount: i.price.amount, currency: i.price.currency },
        chaos: i.chaosEquivalent ?? null,
        bandId: i.bandId,
        role: i.role,
        gainPct: pct(e.gain.gain),
        dpsPct: pct(e.gain.dpsPct),
        ehpPct: pct(e.gain.ehpPct),
        floorsPass: e.floorsPass,
        failedFloors: details(e.failedFloors),
        flags: details(e.flags),
        missedTargets: details(e.missedTargets),
        notes: e.notes.map((n) => n.text),
        unparsed: [...e.scored.unparsed],
        text: i.text,
        view: i.display ?? null,
        changes: statChanges(baseline, e.scored.stats),
        planChecks: planChecks(e.plan),
        hasBuyLink: buyLink(league, i) !== undefined,
        hidden: filtered?.hidden ?? null,
        hiddenBy: filtered?.hiddenBy ?? null,
    };
}

export function toUiBand(b: PriceBand): UiBand {
    return { id: b.id, label: b.label, role: b.role };
}

export function toUiSearch(s: SearchRecord): UiSearch {
    return {
        bandId: s.bandId,
        option: s.option,
        total: s.total ?? null,
        fetchPlanned: s.fetchPlanned,
        complexity: s.siteComplexity ?? s.predictedComplexity,
        error: s.error ?? null,
    };
}

export function toUiSummary(
    result: RunResult,
    league: string,
    baseline: PobStats,
    finishedAtMs: number,
    startedAtMs: number,
    runFile: string | null,
): RunSummaryUi {
    const v = result.verdict;
    return {
        verdict: v.kind,
        note: v.note,
        pickId: v.kind === 'pick' ? v.pick.item.id : null,
        bestId: v.best?.item.id ?? null,
        overBudgetIds: v.overBudget.map((e: EvaluatedItem) => e.item.id),
        counts: { ...result.counts },
        stoppedReason: result.stoppedReason ?? null,
        finishedAtMs: finishedAtMs,
        seconds: (finishedAtMs - startedAtMs) / 1000,
        items: result.items.map((f: FilteredItem) => toUiItem(f.evaluated, league, baseline, f)),
        runFile: runFile,
    };
}

export interface LimiterWait {
    readonly policy: string;
    readonly untilMs: number;
    readonly reason: string;
}

/** The rate-limit panel: each window as "count of allowed per period" (PLAN.md, UI: Run live). */
export function limitPanel(snapshot: ReadonlyMap<TradePolicy, PolicySnapshot>, wait: LimiterWait | undefined, nowMs: number): LimitPanel {
    const policies: LimitPolicy[] = [];
    for (const [key, p] of snapshot.entries()) {
        policies.push({
            policy: key,
            windows: p.windows.map((w) => ({ count: w.count, allowed: w.allowed, limit: w.limit, periodS: w.period })),
        });
    }
    policies.sort((a: LimitPolicy, b: LimitPolicy) => a.policy.localeCompare(b.policy));
    return { policies: policies, wait: wait !== undefined && wait.untilMs > nowMs ? wait : null };
}
