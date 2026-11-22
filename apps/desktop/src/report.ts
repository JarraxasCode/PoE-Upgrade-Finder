// Text for the headless run: live lines as items are scored, and the summary at the end (pure).

import { signed, table } from '@poe-upgrade-finder/cli/format';
import { buyLink } from '@poe-upgrade-finder/core';
import type { EvaluatedItem, FilteredItem, JunkReason, PriceBand, RunResult, SearchRecord, Verdict } from '@poe-upgrade-finder/core';

export function priceText(e: EvaluatedItem): string {
    const p = e.item.price;
    if (p === undefined) {
        return 'no price';
    }
    const native: string = `${p.amount}${p.currency === 'chaos' ? 'c' : p.currency === 'divine' ? 'd' : ` ${p.currency}`}`;
    if (p.currency === 'chaos' || e.item.chaosEquivalent === undefined) {
        return native;
    }
    return `${native} ≈ ${Math.round(e.item.chaosEquivalent)}c`;
}

function itemName(e: EvaluatedItem): string {
    return e.item.name === '' ? e.item.baseType : `${e.item.name}, ${e.item.baseType}`;
}

function tags(e: EvaluatedItem): string {
    const out: string[] = [];
    for (const f of e.flags) {
        out.push(f.checkId === 'life-loss' ? 'LIFE LOSS' : f.checkId.toUpperCase());
    }
    for (const t of e.missedTargets) {
        out.push(`below ${t.checkId.replace(/^target-/, '')}`);
    }
    if (e.scored.unparsed.length > 0) {
        out.push(`${e.scored.unparsed.length} unparsed`);
    }
    return out.join(', ');
}

/** One line per scored item that is worth a look (floors pass, gain at least the minimum). */
export function liveLine(e: EvaluatedItem, minGainPct: number): string | undefined {
    if (!e.floorsPass || !(e.gain.gain >= minGainPct)) {
        return undefined;
    }
    const t: string = tags(e);
    return `  find  ${signed(e.gain.gain, 2)}%  (DPS ${signed(e.gain.dpsPct, 2)}%, EHP ${signed(e.gain.ehpPct, 2)}%)  ${priceText(e)}  ${itemName(e)}${t === '' ? '' : `  [${t}]`}`;
}

function verdictText(v: Verdict): string {
    const lines: string[] = [`VERDICT: ${v.note}`];
    for (const o of v.overBudget.slice(0, 3)) {
        lines.push(`  note: slightly over budget, ${itemName(o)} ${signed(o.gain.gain, 2)}% for ${priceText(o)}`);
    }
    return lines.join('\n');
}

const REASONS: Readonly<Record<JunkReason, string>> = {
    floor: 'broke a floor',
    'no-gain': 'no gain figure',
    'low-gain': 'under the minimum gain',
    duplicate: 'same item, same seller',
    dominated: 'costs more and gains less than another',
};

export interface SummaryInput {
    readonly league: string;
    readonly slot: string;
    readonly budgetText: string;
    readonly rateText: string;
    readonly bands: readonly PriceBand[];
    readonly result: RunResult;
    readonly minGainPct: number;
    readonly top: number;
}

function searchRows(searches: readonly SearchRecord[], bands: readonly PriceBand[]): string[][] {
    return searches.map((s: SearchRecord) => [
        bands.find((b: PriceBand) => b.id === s.bandId)?.label ?? s.bandId,
        s.option,
        s.error === undefined ? String(s.total ?? '') : 'refused',
        String(s.ids),
        String(s.fetchPlanned),
        `${s.predictedComplexity}${s.siteComplexity === undefined ? '' : ` / ${s.siteComplexity}`}`,
    ]);
}

export function summaryText(input: SummaryInput): string {
    const r: RunResult = input.result;
    const shown: FilteredItem[] = r.items.filter((f: FilteredItem) => f.hidden === undefined).sort((a: FilteredItem, b: FilteredItem) => b.evaluated.gain.gain - a.evaluated.gain.gain);
    const out: string[] = [];
    out.push(`${input.slot}, ${input.league}, budget ${input.budgetText}, divine ${input.rateText}`);
    if (r.stoppedReason !== undefined) {
        out.push(`STOPPED EARLY: ${r.stoppedReason}`);
    }
    out.push('');
    out.push(verdictText(r.verdict));
    out.push('');
    out.push(`Worth a look (${shown.length}), best gain first:`);
    const top: FilteredItem[] = shown.slice(0, input.top);
    out.push(table(
        ['#', 'gain %', 'DPS %', 'EHP %', 'price', 'band', 'item', 'tags'],
        top.map((f: FilteredItem, i: number) => [
            String(i + 1),
            signed(f.evaluated.gain.gain, 2),
            signed(f.evaluated.gain.dpsPct, 2),
            signed(f.evaluated.gain.ehpPct, 2),
            priceText(f.evaluated),
            input.bands.find((b: PriceBand) => b.id === f.evaluated.item.bandId)?.role === 'over' ? 'over' : f.evaluated.item.bandId.replace('band-', ''),
            itemName(f.evaluated),
            tags(f.evaluated),
        ]),
        [true, true, true, true, true, false, false, false],
    ).trimEnd());
    if (top.length > 0) {
        out.push('');
        out.push('Buy links (open in your browser):');
        top.forEach((f: FilteredItem, i: number) => {
            out.push(`  ${i + 1}. ${buyLink(input.league, f.evaluated.item) ?? '(no seller name)'}`);
        });
    }
    out.push('');
    const hiddenCounts: Map<JunkReason, number> = new Map<JunkReason, number>();
    for (const f of r.items) {
        if (f.hidden !== undefined) {
            hiddenCounts.set(f.hidden, (hiddenCounts.get(f.hidden) ?? 0) + 1);
        }
    }
    out.push(`Run: ${r.counts.searches} searches, ${r.counts.fetched} fetched, ${r.counts.scored} scored, ${shown.length} worth a look; filtered out:`);
    for (const [reason, n] of hiddenCounts) {
        out.push(`  ${n} ${REASONS[reason]}`);
    }
    const floorFails: Map<string, number> = new Map<string, number>();
    for (const f of r.items) {
        for (const c of f.evaluated.failedFloors) {
            floorFails.set(c.checkId, (floorFails.get(c.checkId) ?? 0) + 1);
        }
    }
    if (floorFails.size > 0) {
        out.push(`  floors broken: ${[...floorFails].map(([id, n]: [string, number]) => `${id} ${n}`).join(', ')}`);
    }
    if (r.counts.failed + r.counts.missing + r.counts.skipped > 0) {
        out.push(`Issues: ${r.counts.failed} failed to score, ${r.counts.missing} gone before fetch, ${r.counts.skipped} skipped (unidentified, wrong slot, already fetched or unreadable)`);
    }
    out.push('');
    out.push('Searches (complexity: predicted / site):');
    out.push(table(['band', 'currency', 'total', 'ids', 'fetched', 'complexity'], searchRows(r.searches, input.bands), [false, false, true, true, true, true]).trimEnd());
    return `${out.join('\n')}\n`;
}
