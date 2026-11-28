// One scored item through the fixed pipeline's last stages (PLAN.md, Search spec): run the spec's checks,
// attach notes from its noters, and compute the gain. PoB's numbers are used as they are.

import { gainOf } from './gain.ts';
import type { Gain } from './gain.ts';
import type { CheckResult, ItemCheck, ItemNote, ListedItem, ScoredStats, SlotSearchSpec } from './spec.ts';
import type { PobStats } from './stats.ts';
import { matchPlan } from './plan-match.ts';
import type { PlanMatch } from './plan-match.ts';
import type { ItemLine } from '@poe-upgrade-finder/vocab';

export interface EvaluatedItem {
    readonly item: ListedItem;
    readonly scored: ScoredStats;
    readonly gain: Gain;
    readonly checks: readonly CheckResult[];
    readonly notes: readonly ItemNote[];
    /** No floor failed. */
    readonly floorsPass: boolean;
    readonly failedFloors: readonly CheckResult[];
    /** Targets the item ends below (badges). */
    readonly missedTargets: readonly CheckResult[];
    /** Flags raised (life loss, net regen negative). */
    readonly flags: readonly CheckResult[];
    /** Which lines met each requirement, and the exclusions and defences (issue #6); empty lists without any. */
    readonly plan: PlanMatch;
}

export function evaluateItem(
    spec: SlotSearchSpec,
    baseline: PobStats,
    item: ListedItem,
    scored: ScoredStats,
    blend: number,
): EvaluatedItem {
    const checks: CheckResult[] = spec.checks.map((c: ItemCheck) => c.evaluate(baseline, scored.stats));
    const notes: ItemNote[] = [];
    for (const noter of spec.noters) {
        notes.push(...noter.notesFor(item, scored));
    }
    const failed = (kind: CheckResult['kind']): CheckResult[] => checks.filter((c: CheckResult) => c.kind === kind && c.status === 'fail');
    const failedFloors: CheckResult[] = failed('floor');
    return {
        item: item,
        scored: scored,
        gain: gainOf(baseline, scored.stats, blend),
        checks: checks,
        notes: notes,
        floorsPass: failedFloors.length === 0,
        failedFloors: failedFloors,
        missedTargets: failed('target'),
        flags: failed('flag'),
        plan: matchPlan(spec, {
            statLines: item.statLines,
            properties: item.display?.properties.map((line: ItemLine) => line.map((p) => p.text).join('')),
            sockets: item.display?.sockets,
        }),
    };
}
