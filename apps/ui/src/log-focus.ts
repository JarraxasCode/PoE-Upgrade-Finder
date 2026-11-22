// A warning or error in the Run view's feed opens Settings → Logs at its line (PLAN.md, Phase 4). Main writes
// those feed lines to the run's log with the same text (run-controller `feed`), so the line is found by
// level, text and the nearest time. DOM-free, so it is unit-tested.

import type { UiLogLine } from '@poe-upgrade-finder/ipc';

export interface LogFocus {
    readonly runId: string;
    readonly level: 'warn' | 'error';
    readonly atMs: number;
    readonly text: string;
}

/** The feed entry and its log line are written in the same tick; anything further off isn't the same line. */
export const MATCH_WINDOW_MS: number = 5000;

/** The index of the log line the feed entry was written as, or -1. */
export function findFocusLine(lines: readonly UiLogLine[], focus: LogFocus): number {
    let best: number = -1;
    let bestGap: number = MATCH_WINDOW_MS + 1;
    lines.forEach((l: UiLogLine, i: number) => {
        if (l.level !== focus.level || l.msg !== focus.text) {
            return;
        }
        const gap: number = Math.abs(l.t - focus.atMs);
        if (gap < bestGap) {
            best = i;
            bestGap = gap;
        }
    });
    return best;
}
