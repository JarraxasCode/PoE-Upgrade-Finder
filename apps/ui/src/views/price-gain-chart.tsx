// Price vs overall gain on the results: one dot per scored item (log price across, gain up), the budget and the
// minimum gain as reference lines, the pick marked. Hover (or focus and arrow keys) reads an item out underneath;
// the item list below is the table view, so nothing is only reachable by hovering. Colours are tokens in
// styles.css (validated with the dataviz skill's checker against the card surface); the CSP allows no inline
// styles, so everything is SVG attributes and classes.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX, RefObject, TargetedKeyboardEvent, TargetedPointerEvent } from 'preact';
import type { RunHeader, UiItem } from '@poe-upgrade-finder/ipc';
import { linPos, logPos, priceTick } from '../chart-model.ts';
import type { ChartModel, ChartPoint } from '../chart-model.ts';
import { signedPct } from '../format.ts';
import { bandLabel } from '../run-model.ts';
import { Orb } from './price.tsx';
import { anchorClass, hideTip, showTip } from '../state/tip.ts';
import { ItemImage } from './item-card.tsx';

const TIP_PREFIX: string = 'chart:';

const HEIGHT: number = 280;
const PAD = { left: 52, right: 20, top: 22, bottom: 30 } as const;
/** The pointer only has to be this close (px) to a dot, not on it. */
const HIT_RADIUS: number = 24;

interface Props {
    readonly model: ChartModel;
    readonly header: RunHeader;
    readonly pickId: string | null;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState<number>(640);
    useEffect(() => {
        const el: HTMLDivElement | null = ref.current;
        if (el === null) {
            return undefined;
        }
        const observer: ResizeObserver = new ResizeObserver(() => {
            setWidth(Math.max(320, Math.floor(el.clientWidth)));
        });
        observer.observe(el);
        return () => {
            observer.disconnect();
        };
    }, []);
    return [ref, width];
}

export function PriceGainChart(props: Props): JSX.Element {
    const { model, header, pickId } = props;
    const [wrapRef, width] = useWidth();
    const [hoverId, setHoverId] = useState<string | null>(null);
    const plotW: number = width - PAD.left - PAD.right;
    const plotH: number = HEIGHT - PAD.top - PAD.bottom;
    const px = (v: number): number => PAD.left + logPos(model.x, v) * plotW;
    const py = (v: number): number => PAD.top + (1 - linPos(model.y, v)) * plotH;

    const pick: ChartPoint | undefined = model.points.find((p: ChartPoint) => p.item.id === pickId);
    const hovered: ChartPoint | undefined = model.points.find((p: ChartPoint) => p.item.id === hoverId);
    const shown: ChartPoint | undefined = hovered ?? pick;

    // The tooltip's anchor: Chromium won't take anything inside an <svg> as a CSS anchor, so an HTML box sits over
    // the hovered dot. It is moved through the CSSOM, which the CSP allows (it only blocks style attributes).
    const anchorRef: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el: HTMLDivElement | null = anchorRef.current;
        if (el !== null && hovered !== undefined) {
            el.style.left = `${px(hovered.x) - 7}px`;
            el.style.top = `${py(hovered.y) - 7}px`;
        }
    });

    // The hovered (or arrowed-to) dot holds the item tooltip, anchored to it.
    useEffect(() => {
        if (hovered === undefined) {
            return undefined;
        }
        const key: string = TIP_PREFIX + hovered.item.id;
        showTip(key, hovered.item.view);
        return () => {
            hideTip(key);
        };
    }, [hovered?.item.id]);

    const onMove = (e: TargetedPointerEvent<SVGSVGElement>): void => {
        const box: DOMRect = e.currentTarget.getBoundingClientRect();
        const mx: number = e.clientX - box.left;
        const my: number = e.clientY - box.top;
        let best: ChartPoint | undefined;
        let bestD: number = HIT_RADIUS * HIT_RADIUS;
        for (const p of model.points) {
            const dx: number = px(p.x) - mx;
            const dy: number = py(p.y) - my;
            const d: number = dx * dx + dy * dy;
            if (d <= bestD) {
                bestD = d;
                best = p;
            }
        }
        setHoverId(best === undefined ? null : best.item.id);
    };

    // Keyboard: the chart is one focus stop; arrows step through the dots by price.
    const byPrice: ChartPoint[] = [...model.points].sort((a: ChartPoint, b: ChartPoint) => a.x - b.x || b.y - a.y);
    const onKey = (e: TargetedKeyboardEvent<SVGSVGElement>): void => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') {
            return;
        }
        e.preventDefault();
        const at: number = byPrice.findIndex((p: ChartPoint) => p.item.id === (shown?.item.id ?? ''));
        const next: number = e.key === 'ArrowRight' ? Math.min(byPrice.length - 1, at + 1) : Math.max(0, at - 1);
        setHoverId(byPrice[next]?.item.id ?? null);
    };

    const budgetX: number = px(model.budgetChaos);
    const minGainY: number = py(model.minGainPct);
    const worth: number = model.points.filter((p: ChartPoint) => p.kind === 'worth').length;
    const label: string = `Price against overall gain for ${model.points.length} scored items; ${worth} worth a look. Use the arrow keys to read items out.`;

    return (
        <div class="card chart-card">
            <h2>Price vs gain</h2>
            <ul class="chart-legend muted small" aria-hidden="true">
                <li>
                    <svg width="12" height="12">
                        <circle cx="6" cy="6" r="4" class="pt worth" />
                    </svg>
                    Worth a look
                </li>
                <li>
                    <svg width="12" height="12">
                        <circle cx="6" cy="6" r="4" class="pt other" />
                    </svg>
                    Filtered out
                </li>
                <li>
                    <svg width="12" height="12">
                        <circle cx="6" cy="6" r="3.5" class="pt floor" />
                    </svg>
                    Breaks a floor
                </li>
                {pick !== undefined && (
                    <li>
                        <svg width="14" height="14">
                            <circle cx="7" cy="7" r="5" class="pt pick" />
                        </svg>
                        The pick
                    </li>
                )}
            </ul>
            <div ref={wrapRef} class="chart-wrap">
                <svg
                    width={width}
                    height={HEIGHT}
                    class="chart"
                    role="img"
                    aria-label={label}
                    tabIndex={0}
                    onPointerMove={onMove}
                    onPointerLeave={() => {
                        setHoverId(null);
                    }}
                    onBlur={() => {
                        setHoverId(null);
                    }}
                    onKeyDown={onKey}
                >
                    {model.y.ticks.map((t: number) => (
                        <g key={`y${t}`}>
                            <line x1={PAD.left} x2={width - PAD.right} y1={py(t)} y2={py(t)} class={t === 0 ? 'axis-zero' : 'grid'} />
                            <text x={PAD.left - 8} y={py(t) + 4} class="tick" text-anchor="end">
                                {t === 0 ? '0%' : signedPct(t, Math.abs(t) < 10 && !Number.isInteger(t) ? 1 : 0)}
                            </text>
                        </g>
                    ))}
                    {model.x.ticks.map((t: number) => (
                        <text key={`x${t}`} x={px(t)} y={HEIGHT - 8} class="tick" text-anchor="middle">
                            {priceTick(t)}
                        </text>
                    ))}
                    <line x1={budgetX} x2={budgetX} y1={PAD.top} y2={PAD.top + plotH} class="ref" />
                    <text x={budgetX - 6} y={PAD.top - 8} class="ref-label" text-anchor="end">
                        budget {header.budgetLabel}
                    </text>
                    {minGainY >= PAD.top && minGainY <= PAD.top + plotH && (
                        <g>
                            <line x1={PAD.left} x2={width - PAD.right} y1={minGainY} y2={minGainY} class="ref" />
                            <text x={width - PAD.right} y={minGainY - 6} class="ref-label" text-anchor="end">
                                +{header.minGainPct}% minimum
                            </text>
                        </g>
                    )}
                    {model.points.map((p: ChartPoint) => (
                        <circle
                            key={p.item.id}
                            cx={px(p.x)}
                            cy={py(p.y)}
                            r={p.kind === 'floor' ? 3.5 : 4}
                            class={`pt ${p.kind}${p.item.id === hoverId ? ' hover' : ''}`}
                        />
                    ))}
                    {pick !== undefined && (
                        <g>
                            <circle cx={px(pick.x)} cy={py(pick.y)} r={6} class={`pt pick${pick.item.id === hoverId ? ' hover' : ''}`} />
                            <text x={px(pick.x) + 10} y={py(pick.y) - 8} class="pt-label">
                                Pick
                            </text>
                        </g>
                    )}
                </svg>
                {hovered !== undefined && (
                    <div ref={anchorRef} class={`chart-anchor${anchorClass(TIP_PREFIX + hovered.item.id)}`} aria-hidden="true" />
                )}
            </div>
            <Readout point={shown} header={header} isPick={shown !== undefined && shown === pick && hovered === undefined} />
            {(model.clipped > 0 || model.unplotted > 0) && (
                <p class="muted small">
                    {model.clipped > 0 &&
                        `${model.clipped} item${model.clipped === 1 ? '' : 's'} below ${model.y.min}% drawn on the bottom edge. `}
                    {model.unplotted > 0 && `${model.unplotted} not on the chart (no chaos price or no gain figure); they're in the list.`}
                </p>
            )}
        </div>
    );
}

function Readout(props: { readonly point: ChartPoint | undefined; readonly header: RunHeader; readonly isPick: boolean }): JSX.Element {
    const p: ChartPoint | undefined = props.point;
    if (p === undefined) {
        return (
            <p class="chart-readout muted small" aria-live="polite">
                Hover a dot to read the item.
            </p>
        );
    }
    const i: UiItem = p.item;
    return (
        <p class="chart-readout small" aria-live="polite">
            {i.view !== null && <ItemImage view={i.view} size="row" />}
            {props.isPick && <span class="muted">The pick: </span>}
            <strong class="num">{signedPct(i.gainPct ?? 0)}</strong>
            <span class="muted">
                {' '}
                overall · DPS {pct(i.dpsPct)} · EHP {pct(i.ehpPct)} ·{' '}
            </span>
            {i.price === null ? (
                <span class="muted">no price</span>
            ) : (
                <strong>
                    <Orb currency={i.price.currency} amount={i.price.amount} />
                </strong>
            )}
            <span class="muted"> · </span>
            {i.name || i.baseType}
            <span class="muted">
                {' '}
                · {i.name ? `${i.baseType} · ` : ''}
                {bandLabel(props.header, i.bandId)}
            </span>
        </p>
    );
}

function pct(n: number | null): string {
    return n === null ? 'n/a' : signedPct(n);
}
