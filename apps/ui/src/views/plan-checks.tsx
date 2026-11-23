// The slot plan in the Run view (issue #6): what the run searched with (the header card), and on each find
// which of its lines met each include, hard need, exclude and defence. The site filtered every result on
// these already; a "missed" means the app's reading of the site's rules is off for that item, not that the
// item was let through on purpose.

import type { JSX } from 'preact';
import type { RunHeader, UiPlanCheck, UiPlanRule, UiRunPlan } from '@poe-upgrade-finder/ipc';
import { chipValue, PLAN_MARK, planCheckText, planChip } from '../run-model.ts';
import type { PlanChip as PlanChipModel } from '../run-model.ts';
import { Info } from './item-card.tsx';

const KIND_TEXT: Readonly<Record<UiPlanCheck['kind'], string>> = {
    include: 'Include',
    need: 'Build needs',
    exclude: 'Exclude',
    defence: 'Defence',
};

const QUALITY_TIP: string =
    'The trade site compares defences at 20% quality: an item below 20% counts as listed × 1.2 / (1 + quality). PoB scores the item as it is listed.';

/** The chip on a find's row: hover for each check. */
export function PlanChip(props: { readonly tipKey: string; readonly checks: readonly UiPlanCheck[] }): JSX.Element | null {
    const chip: PlanChipModel | null = planChip(props.checks);
    if (chip === null) {
        return null;
    }
    const lines: string[] = props.checks.map(planCheckText);
    if (chip.status === 'missed') {
        lines.push("The site's filter let this item through, so the app's reading of it is off here: check the item before buying.");
    }
    return (
        <Info tipKey={props.tipKey} title="Slot plan" lines={lines} class={`plan-chip ${chip.status}`}>
            {chip.text}
        </Info>
    );
}

/** What a check's hover says: its kind, the item's lines that count for it, and any note. */
function checkTip(c: UiPlanCheck): string[] {
    const lines: string[] = [];
    if (c.kind === 'exclude') {
        lines.push(c.status === 'met' ? 'None on the item.' : 'On the item.');
    }
    if (c.status === 'missed' && (c.kind === 'include' || c.kind === 'need') && c.lines.length === 0) {
        lines.push('No line on the item carries it.');
    }
    for (const l of c.lines) {
        lines.push(l.note === '' ? l.text : `${l.text} (${l.note})`);
    }
    if (c.kind === 'defence' && c.value !== null) {
        lines.push(`On the item: ${c.value}.`, QUALITY_TIP);
    }
    return lines;
}

/** The find's detail: one small chip per check, the lines behind it on hover. */
export function PlanChecks(props: { readonly tipKey: string; readonly checks: readonly UiPlanCheck[] }): JSX.Element | null {
    if (props.checks.length === 0) {
        return null;
    }
    return (
        <div class="plan-checks">
            <span class="detail-h">Slot plan</span>
            <ul class="plan-check-chips">
                {props.checks.map((c: UiPlanCheck, k: number) => (
                    <li key={k} class={`plan-check ${c.status}`}>
                        <Info tipKey={`${props.tipKey}:${k}`} title={`${KIND_TEXT[c.kind]}: ${c.label}`} lines={checkTip(c)}>
                            <span class="plan-mark" aria-label={c.status}>
                                {PLAN_MARK[c.status]}
                            </span>
                            {c.kind === 'exclude' ? `no ${c.label}` : c.label}
                            {chipValue(c) !== null && <span class="num muted"> · {chipValue(c)}</span>}
                        </Info>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function Rule(props: { readonly tipKey: string; readonly rule: UiPlanRule }): JSX.Element {
    const r: UiPlanRule = props.rule;
    if (r.counts === null) {
        return <li>{r.label}</li>;
    }
    return (
        <li>
            <Info tipKey={props.tipKey} title={r.label} lines={[`A total: counts ${r.counts}.`]}>
                {r.label}
            </Info>
        </li>
    );
}

/** What the run searched with: the plan's base, includes, excludes and defences, and the level filter. */
export function RunPlanSummary(props: { readonly header: RunHeader }): JSX.Element {
    const h: RunHeader = props.header;
    const p: UiRunPlan | null = h.plan;
    return (
        <div class="run-plan small">
            {p !== null && (
                <>
                    <p>
                        <strong>Slot plan:</strong> {p.base ?? `any ${p.itemType ?? h.slot} base`}
                        {p.influences.length > 0 && <span class="muted"> · {p.influences.join(' and ')}</span>}
                    </p>
                    {p.includes.length > 0 && (
                        <>
                            <p class="muted">Must have</p>
                            <ul class="plan-rules">
                                {p.includes.map((r: UiPlanRule, k: number) => (
                                    <Rule key={k} tipKey={`run-plan-include:${k}`} rule={r} />
                                ))}
                            </ul>
                        </>
                    )}
                    {p.excludes.length > 0 && (
                        <>
                            <p class="muted">Never</p>
                            <ul class="plan-rules">
                                {p.excludes.map((e: string, k: number) => (
                                    <li key={k}>{e}</li>
                                ))}
                            </ul>
                        </>
                    )}
                    {p.defences.length > 0 && (
                        <p>
                            <Info tipKey="run-plan-defences" title="Defences" lines={[QUALITY_TIP]}>
                                Defences: {p.defences.join(', ')}
                            </Info>
                        </p>
                    )}
                    {p.pruned > 0 && (
                        <p class="muted">
                            {p.pruned} of PoB's weight{p.pruned === 1 ? '' : 's'} taken out by the plan
                        </p>
                    )}
                    {p.notes.map((n: string, k: number) => (
                        <p key={k} class="muted">
                            {n}
                        </p>
                    ))}
                </>
            )}
            <p class="muted">Required level: {h.levelFilter}</p>
        </div>
    );
}
