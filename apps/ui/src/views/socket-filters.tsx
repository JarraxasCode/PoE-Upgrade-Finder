// The slot plan's socket filters (#58), as on the trade site: a Sockets row and a Link groups row, each with a
// count per colour and min/max. Shown on every item type and in Unique mode too (the slot's one filter, kept on
// its rare plan); the user knows what can have sockets. A row is saved as a whole, and only when it reads: a bad
// box or a min above the max stays typed and marked (ipc refuses such a plan, and with it the build's settings).

import { useEffect, useState } from 'preact/hooks';
import type { JSX, TargetedEvent } from 'preact';
import { SOCKET_ENDS } from '@poe-upgrade-finder/vocab';
import type { SlotPlan, SocketEnd, SocketRange, SocketRow } from '@poe-upgrade-finder/vocab';
import { parseSocketValue, socketRowFromTexts, withSocketRow } from '../slot-plan-model.ts';
import type { SocketRowRead } from '../slot-plan-model.ts';
import { setSlotPlan } from '../state/plan.ts';
import { Info } from './item-card.tsx';

const ROW_NAMES: Readonly<Record<SocketRow, string>> = { sockets: 'Sockets', links: 'Link groups' };
const END_NAMES: Readonly<Record<SocketEnd, string>> = { r: 'R', g: 'G', b: 'B', w: 'W', min: 'Min', max: 'Max' };

type RowTexts = Readonly<Record<SocketEnd, string>>;

function textsOf(range: SocketRange): RowTexts {
    const out: Partial<Record<SocketEnd, string>> = {};
    for (const end of SOCKET_ENDS) {
        const n: number | undefined = range[end];
        out[end] = n === undefined ? '' : String(n);
    }
    return { r: out.r ?? '', g: out.g ?? '', b: out.b ?? '', w: out.w ?? '', min: out.min ?? '', max: out.max ?? '' };
}

function sameRange(a: SocketRange, b: SocketRange): boolean {
    return SOCKET_ENDS.every((end: SocketEnd) => a[end] === b[end]);
}

function SocketRowFields(props: { readonly plan: SlotPlan; readonly row: SocketRow }): JSX.Element {
    const { plan, row } = props;
    const saved: SocketRange = plan.sockets?.[row] ?? {};
    const savedKey: string = JSON.stringify(textsOf(saved));
    const [texts, setTexts] = useState<RowTexts>(textsOf(saved));
    useEffect(() => {
        setTexts(textsOf(saved));
    }, [savedKey]);
    const read: SocketRowRead = socketRowFromTexts(texts);
    const commit = (): void => {
        if (read.ok && !sameRange(read.range, saved)) {
            setSlotPlan(withSocketRow(plan, row, read.range));
        }
    };
    const minAboveMax: boolean = !read.ok && read.problem === 'The min is above the max.';
    return (
        <div class="stat-range socket-row">
            <span class="stat-range-label">{ROW_NAMES[row]}</span>
            {SOCKET_ENDS.map((end: SocketEnd) => (
                <input
                    key={end}
                    class={`num socket-input socket-${end}`}
                    inputMode="numeric"
                    aria-label={`${ROW_NAMES[row]} ${END_NAMES[end]}`}
                    aria-invalid={parseSocketValue(texts[end]) === undefined || (minAboveMax && (end === 'min' || end === 'max'))}
                    placeholder={END_NAMES[end]}
                    title={END_NAMES[end]}
                    value={texts[end]}
                    onInput={(e: TargetedEvent<HTMLInputElement>) => {
                        const value: string = e.currentTarget.value;
                        setTexts((t: RowTexts) => ({ ...t, [end]: value }));
                    }}
                    onChange={commit}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                            commit();
                        }
                    }}
                />
            ))}
            {!read.ok && <span class="hint fail stat-range-problem">{read.problem} Not saved yet.</span>}
        </div>
    );
}

/** The Socket filters section: the trade site's two rows, for the slot's plan (rare or unique search). */
export function SocketFilters(props: { readonly plan: SlotPlan }): JSX.Element {
    return (
        <section class="plan-section plan-sockets" aria-label="Socket filters">
            <h3 class="plan-section-head">
                <Info
                    tipKey="plan-sockets"
                    title="Socket filters"
                    lines={[
                        'As on the trade site. Sockets counts every socket on the item (abyssal sockets too); its R, G, B and W count sockets of that colour anywhere on it.',
                        'Link groups is the largest group of linked sockets: min 6 and max 6 finds 6-links only. Its R, G, B and W count colours inside that group.',
                        'Whole numbers from 0 to 6; empty boxes are no limit. In Unique mode the same filter applies to the unique.',
                    ]}
                >
                    Socket filters
                </Info>
            </h3>
            <div class="plan-ranges">
                <SocketRowFields plan={props.plan} row="sockets" />
                <SocketRowFields plan={props.plan} row="links" />
            </div>
        </section>
    );
}
