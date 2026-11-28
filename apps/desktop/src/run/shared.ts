// What every run uses: PoB as the run's engine, the run's JSON record
// (runs/<run id>.json, PLAN.md, Data: each run's query, scored items and picks) and keeping the last 20.

import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buyLink, saveSpec } from '@poe-upgrade-finder/core';
import type { EngineScore, FilteredItem, PlanGear, RunEngine, RunResult, SlotSearchSpec } from '@poe-upgrade-finder/core';
import type { EngineClient, ItemInfo, ResolvedTarget, ScoreItemResult, StatBlock, TargetRequest } from '@poe-upgrade-finder/engine-client';
import type { GearSlot, LevelFilter, SlotPlan } from '@poe-upgrade-finder/vocab';

/** The build's weapons as the plan check reads them (#39), from what PoB loaded. */
export function planGear(equipped: readonly { readonly slot: string; readonly type: string | undefined }[]): PlanGear {
    const typeIn = (slot: string): string | null => {
        const item = equipped.find((e) => e.slot === slot);
        return item === undefined ? null : (item.type ?? null);
    };
    return { weapon1Type: typeIn('Weapon 1'), weapon2Type: typeIn('Weapon 2') };
}

/** PoB scores the run's items in its slot, with its damage target. */
export function engineAdapter(engine: EngineClient, slot: GearSlot, target: TargetRequest): RunEngine {
    return {
        async score(texts: readonly string[], onItem: (result: EngineScore) => void, signal?: AbortSignal): Promise<void> {
            await engine.score(
                slot,
                texts,
                (r: ScoreItemResult) => {
                    onItem(
                        r.ok
                            ? {
                                  index: r.index,
                                  ok: true,
                                  stats: r.stats,
                                  unparsed: r.unparsed,
                                  validForSlot: r.validForSlot,
                                  offHandRemoved: r.offHandRemoved,
                              }
                            : { index: r.index, ok: false, message: r.error.message },
                    );
                },
                { target: target, ...(signal === undefined ? {} : { signal: signal }) },
            );
        },
    };
}

export function itemJson(f: FilteredItem, league: string): unknown {
    const e = f.evaluated;
    return {
        id: e.item.id,
        name: e.item.name,
        baseType: e.item.baseType,
        price: e.item.price ?? null,
        chaosEquivalent: e.item.chaosEquivalent ?? null,
        bandId: e.item.bandId,
        gain: e.gain,
        hidden: f.hidden ?? null,
        hiddenBy: f.hiddenBy ?? null,
        failedFloors: e.failedFloors.map((c) => c.detail),
        flags: e.flags.map((c) => c.detail),
        missedTargets: e.missedTargets.map((c) => c.detail),
        unparsed: e.scored.unparsed,
        // Which lines met each include, hard need, exclude and defence (issue #6).
        plan: e.plan,
        buyLink: buyLink(league, e.item) ?? null,
        damage: e.scored.stats.damage,
        values: e.scored.stats.values,
        text: e.item.text,
    };
}

export interface RunRecordInput {
    readonly runId: string;
    readonly startedMs: number;
    readonly finishedMs: number;
    readonly appVersion: string;
    readonly pobVersion: string;
    readonly build: string;
    readonly league: string;
    /** The run's options as given (the Search view's request; older records: the retired headless mode's). */
    readonly options: unknown;
    readonly budgetChaos: number;
    readonly chaosPerDivine: number | undefined;
    readonly baseline: StatBlock;
    readonly target: ResolvedTarget;
    readonly currentItem: ItemInfo;
    readonly spec: SlotSearchSpec;
    readonly result: RunResult;
    /** The slot plan searched; missing: none (records from the retired headless mode). */
    readonly plan?: SlotPlan | undefined;
    /** The build's level requirement filter (issue #22); missing: up to the character's level. */
    readonly levelFilter?: LevelFilter | undefined;
}

export function runRecord(input: RunRecordInput): unknown {
    const verdict = input.result.verdict;
    return {
        runId: input.runId,
        startedAt: new Date(input.startedMs).toISOString(),
        finishedAt: new Date(input.finishedMs).toISOString(),
        seconds: (input.finishedMs - input.startedMs) / 1000,
        appVersion: input.appVersion,
        pobVersion: input.pobVersion,
        build: input.build,
        league: input.league,
        options: input.options,
        budgetChaos: input.budgetChaos,
        chaosPerDivine: input.chaosPerDivine ?? null,
        baseline: { damage: input.baseline.damage, values: input.baseline.values },
        target: input.target,
        currentItem: input.currentItem,
        plan: input.plan ?? null,
        levelFilter: input.levelFilter ?? null,
        spec: saveSpec(input.spec),
        searches: input.result.searches,
        counts: input.result.counts,
        stoppedReason: input.result.stoppedReason ?? null,
        verdict: {
            kind: verdict.kind,
            note: verdict.note,
            pick: verdict.kind === 'pick' ? verdict.pick.item.id : null,
            best: verdict.best?.item.id ?? null,
            overBudget: verdict.overBudget.map((e) => e.item.id),
        },
        items: input.result.items.map((f: FilteredItem) => itemJson(f, input.league)),
    };
}

export function writeRunRecord(runsDir: string, input: RunRecordInput): string {
    const file: string = join(runsDir, `${input.runId}.json`);
    writeFileSync(file, JSON.stringify(runRecord(input), null, 1));
    return file;
}

export const RUNS_KEPT: number = 20;

/** A run's files: <id>.json, <id>.txt, <id>-raw.json, <id>-queries.json. Undefined for anything else. */
export function runIdOf(fileName: string): string | undefined {
    const m: RegExpExecArray | null = /^([A-Za-z0-9]+-\d{4}-\d{2}-\d{2}T[\d-]+Z)(?:-raw\.json|-queries\.json|\.json|\.txt)$/.exec(fileName);
    return m?.[1];
}

/** Keeps the newest `keep` runs (PLAN.md, Data: last 20 runs); returns the run ids removed. */
export function pruneRuns(runsDir: string, keep: number = RUNS_KEPT): string[] {
    let names: string[];
    try {
        names = readdirSync(runsDir);
    } catch {
        return [];
    }
    const newest: Map<string, number> = new Map<string, number>();
    for (const name of names) {
        const id: string | undefined = runIdOf(name);
        if (id !== undefined) {
            const mtime: number = statSync(join(runsDir, name)).mtimeMs;
            newest.set(id, Math.max(newest.get(id) ?? 0, mtime));
        }
    }
    const ids: string[] = [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const drop: Set<string> = new Set<string>(ids.slice(keep));
    for (const name of names) {
        const id: string | undefined = runIdOf(name);
        if (id !== undefined && drop.has(id)) {
            rmSync(join(runsDir, name), { force: true });
        }
    }
    return [...drop];
}
