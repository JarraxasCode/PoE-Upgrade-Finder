// Core's run results → the Run view's types (packages/ipc). Pure, so it is unit-tested. Seller names stay
// in main: the UI only learns whether an item has a buy link.

import { buyLink } from '@poe-upgrade-finder/core';
import type { CheckResult, EvaluatedItem, FilteredItem, PobStats, PriceBand, RunResult, SearchRecord } from '@poe-upgrade-finder/core';
import { statChanges } from './stat-changes.ts';
import type { LimitPanel, LimitPolicy, RunSummaryUi, UiBand, UiItem, UiSearch } from '@poe-upgrade-finder/ipc';
import type { PolicySnapshot, TradePolicy } from '@poe-upgrade-finder/trade';

function pct(n: number): number | null {
    return Number.isFinite(n) ? n : null;
}

const details = (checks: readonly CheckResult[]): string[] => checks.map((c: CheckResult) => c.detail);

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

export function toUiSummary(result: RunResult, league: string, baseline: PobStats, finishedAtMs: number, startedAtMs: number, runFile: string | null): RunSummaryUi {
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
