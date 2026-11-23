// The verdict at the top of the results: the pick (or why there is none) and the short reasons under it.

import type { ComponentChildren, JSX } from 'preact';
import type { RunHeader, RunSnapshot, RunSummaryUi, UiItem } from '@poe-upgrade-finder/ipc';
import { HoverItem, Info } from './item-card.tsx';
import { gainText, tone, ItemList } from './run-items.tsx';

/** One short reason under the verdict: a coloured label and a few words, with an explanation on hover. */
function Reason(props: {
    readonly tipKey: string;
    readonly tone: 'pass' | 'warn' | 'info' | 'neg';
    readonly label: string;
    readonly lines: readonly string[];
    readonly children: ComponentChildren;
}): JSX.Element {
    return (
        <li class={`reason ${props.tone}`}>
            <Info tipKey={props.tipKey} title={props.label} lines={props.lines} class="reason-label">
                {props.label}
            </Info>
            <span class="reason-text">{props.children}</span>
        </li>
    );
}

function chaosText(n: number | null): string {
    return n === null ? '?' : `${n >= 100 ? Math.round(n).toLocaleString('en-GB') : n.toFixed(1)}c`;
}

/** The verdict: the pick (or the best that wasn't enough) as a large row, and the reasons as short points. */
export function Verdict(props: {
    readonly snap: RunSnapshot;
    readonly summary: RunSummaryUi;
    readonly pick: UiItem | undefined;
    readonly best: UiItem | undefined;
    readonly tags: ReadonlyMap<string, string>;
}): JSX.Element {
    const { summary, pick, best } = props;
    const h: RunHeader = props.snap.header;
    const isPick: boolean = summary.verdict === 'pick' && pick !== undefined;
    const shown: UiItem | undefined = isPick ? pick : best;
    const over: number = summary.overBudgetIds.length;
    return (
        <div class={`card verdict ${summary.verdict}`}>
            <h2 class="verdict-h">
                <span class="verdict-mark" aria-hidden="true">
                    {isPick ? '★' : '–'}
                </span>
                {isPick ? 'The pick' : 'No upgrade found'}
            </h2>
            <ul class="reasons" aria-label="Why">
                {isPick && pick !== undefined && (
                    <Reason
                        tipKey="why-value"
                        tone="pass"
                        label="Best value"
                        lines={[
                            'The cheapest item in budget whose overall gain is at least 80% of the best gain on offer, and at least the minimum gain.',
                            'Paying much more for the last few percent rarely makes sense; the best is named next to it so you can judge.',
                        ]}
                    >
                        <strong class="pass">{gainText(pick.gainPct)}</strong> for <strong>{chaosText(pick.chaos)}</strong>
                    </Reason>
                )}
                {best !== undefined && (!isPick || best.id !== pick?.id) && (
                    <Reason
                        tipKey="why-best"
                        tone="info"
                        label={isPick ? 'Best gain' : 'Best in budget'}
                        lines={[
                            isPick
                                ? 'The biggest overall gain in budget among items that pass the floors.'
                                : 'The biggest overall gain in budget among items that pass the floors. It is shown below.',
                        ]}
                    >
                        <HoverItem tipKey="why-best-item" view={best.view} class="reason-item">
                            <span class={`reason-name r-${best.view?.rarity ?? 'rare'}`}>{best.name || best.baseType}</span>
                        </HoverItem>{' '}
                        <strong class={tone(best.gainPct)}>{gainText(best.gainPct)}</strong> for <strong>{chaosText(best.chaos)}</strong>
                    </Reason>
                )}
                {isPick &&
                    pick !== undefined &&
                    best !== undefined &&
                    best.id !== pick.id &&
                    pick.chaos !== null &&
                    best.chaos !== null &&
                    best.chaos > pick.chaos && (
                        <Reason
                            tipKey="why-saves"
                            tone="pass"
                            label="Saves"
                            lines={["What the pick costs less than the best gain, at the run's divine rate."]}
                        >
                            <strong>{chaosText(best.chaos - pick.chaos)}</strong> against the best, for{' '}
                            {gainText((best.gainPct ?? 0) - (pick.gainPct ?? 0)).replace('+', '')} less gain
                        </Reason>
                    )}
                {!isPick && (
                    <Reason
                        tipKey="why-min"
                        tone="warn"
                        label="Minimum"
                        lines={[`Items need at least +${h.minGainPct}% overall to count as an upgrade. Change it in Settings.`]}
                    >
                        {best === undefined ? 'nothing in budget passed the floors' : `needs +${h.minGainPct}% overall`}
                    </Reason>
                )}
                {over > 0 && (
                    <Reason
                        tipKey="why-over"
                        tone="info"
                        label="Over budget"
                        lines={[
                            'From the "slightly over budget" band. They beat everything in budget: tagged in the list below, never picked.',
                        ]}
                    >
                        {over} item{over === 1 ? '' : 's'} just over budget beat{over === 1 ? 's' : ''} these
                    </Reason>
                )}
            </ul>
            {shown !== undefined && <ItemList header={h} items={[shown]} tags={props.tags} scope="verdict" empty="" hint={false} />}
            {summary.stoppedReason !== null && <p class="warn">The run stopped early: {summary.stoppedReason}</p>}
        </div>
    );
}
