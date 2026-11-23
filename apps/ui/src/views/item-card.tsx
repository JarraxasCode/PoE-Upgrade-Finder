// An item drawn like the in-game tooltip, in poe.ninja's style (docs/reference/poe-ninja-equipment.png): a
// header in the rarity's colours, then properties, requirements, sockets and item level, implicits, the
// item's own mods and the image, separated by thin gold rules. Also the item image on its own, and the
// app-wide hover tooltip that shows a card next to whatever holds it (state/tip.ts).

import { Fragment } from 'preact';
import type { ComponentChildren, JSX } from 'preact';
import type { ItemView, ViewLine, ViewMod, ViewPart } from '@poe-upgrade-finder/ipc';
import { anchorClass, hideTip, showInfo, showTip, tip } from '../state/tip.ts';
import type { TipState } from '../state/tip.ts';

const INFLUENCE_NAMES: Readonly<Record<string, string>> = {
    shaper: 'Shaper',
    elder: 'Elder',
    crusader: 'Crusader',
    redeemer: 'Redeemer',
    hunter: 'Hunter',
    warlord: 'Warlord',
    searing: 'Searing Exarch',
    tangled: 'Eater of Worlds',
};

function Line(props: { readonly line: ViewLine }): JSX.Element {
    return (
        <p>
            {props.line.map((p: ViewPart, k: number) => (
                <span key={k} class={`t-${p.tone}`}>
                    {p.text}
                </span>
            ))}
        </p>
    );
}

const SOCKET_NAMES: Readonly<Record<string, string>> = { R: 'red', G: 'green', B: 'blue', W: 'white', A: 'abyss', D: 'delve' };

/** "R-G-B B" with each socket in its own colour; links and groups as in game. */
function Sockets(props: { readonly sockets: string }): JSX.Element {
    return (
        <p>
            <span class="t-label">Sockets: </span>
            {[...props.sockets].map((ch: string, k: number) => {
                const name: string | undefined = SOCKET_NAMES[ch];
                return name === undefined ? (
                    <span key={k} class="sock-link">
                        {ch}
                    </span>
                ) : (
                    <span key={k} class={`sock sock-${name}`} title={`${name} socket`}>
                        {ch}
                    </span>
                );
            })}
        </p>
    );
}

function Mods(props: { readonly mods: readonly ViewMod[] }): JSX.Element {
    return (
        <div class="ic-section">
            {props.mods.map((m: ViewMod, k: number) => (
                <p key={k} class={`m-${m.kind}`}>
                    {m.text}
                </p>
            ))}
        </div>
    );
}

/** The item image, sized by its inventory cells (classes, not styles: the CSP). */
export function ItemImage(props: { readonly view: ItemView; readonly size: 'row' | 'large' | 'slot' }): JSX.Element | null {
    const v: ItemView = props.view;
    if (v.icon === null) {
        return null;
    }
    return <img class={`item-img img-${props.size} w${v.width} h${v.height}`} src={v.icon} alt="" loading="lazy" draggable={false} />;
}

export function ItemCard(props: { readonly view: ItemView; readonly image?: boolean }): JSX.Element {
    const v: ItemView = props.view;
    const head: ViewLine[] = [];
    if (v.influences.length > 0) {
        head.push([
            { text: 'Influence: ', tone: 'label' },
            { text: v.influences.map((i) => INFLUENCE_NAMES[i] ?? i).join(', '), tone: 'plain' },
        ]);
    }
    const tail: ViewLine[] = [];
    if (v.itemLevel !== null) {
        tail.push([
            { text: 'Item Level: ', tone: 'label' },
            { text: String(v.itemLevel), tone: 'plain' },
        ]);
    }
    const sections: ComponentChildren[] = [];
    const top: ViewLine[] = [...v.properties, ...head];
    if (top.length > 0 || v.sockets !== '' || tail.length > 0) {
        sections.push(
            <div class="ic-section">
                {top.map((l: ViewLine, k: number) => (
                    <Line key={k} line={l} />
                ))}
                {v.sockets !== '' && <Sockets sockets={v.sockets} />}
                {tail.map((l: ViewLine, k: number) => (
                    <Line key={`t${k}`} line={l} />
                ))}
            </div>,
        );
    }
    if (v.requirements.length > 0) {
        sections.push(
            <div class="ic-section">
                <Line line={v.requirements} />
            </div>,
        );
    }
    for (const mods of [v.enchants, v.implicits, v.explicits]) {
        if (mods.length > 0) {
            sections.push(<Mods mods={mods} />);
        }
    }
    if (v.corrupted || v.mirrored) {
        sections.push(
            <div class="ic-section">
                {v.mirrored && <p class="m-mirrored">Mirrored</p>}
                {v.corrupted && <p class="m-corrupted">Corrupted</p>}
            </div>,
        );
    }
    return (
        <div class={`item-card r-${v.rarity}`}>
            <header class="ic-head">
                {v.name !== '' && <p>{v.name}</p>}
                <p>{v.typeLine}</p>
            </header>
            <div class="ic-body">
                {sections.map((s: ComponentChildren, k: number) => (
                    <Fragment key={k}>
                        {k > 0 && <hr class="ic-rule" />}
                        {s}
                    </Fragment>
                ))}
                {props.image !== false && v.icon !== null && (
                    <>
                        <hr class="ic-rule" />
                        <div class="ic-image">
                            <ItemImage view={v} size="large" />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

interface HoverItemProps {
    /** Unique on screen: the element that holds the tooltip is its anchor. */
    readonly tipKey: string;
    readonly view: ItemView | null;
    readonly class?: string;
    readonly children: ComponentChildren;
}

/** Shows the item's tooltip while the pointer is over it or focus is inside it. */
export function HoverItem(props: HoverItemProps): JSX.Element {
    const key: string = props.tipKey;
    const show = (): void => {
        showTip(key, props.view);
    };
    const hide = (): void => {
        hideTip(key);
    };
    return (
        <div class={`${props.class ?? ''}${anchorClass(key)}`} onMouseEnter={show} onMouseLeave={hide} onFocusIn={show} onFocusOut={hide}>
            {props.children}
        </div>
    );
}

interface InfoProps {
    /** Unique on screen. */
    readonly tipKey: string;
    readonly title: string;
    readonly lines: readonly string[];
    readonly class?: string;
    readonly children: ComponentChildren;
}

/** Text with an explanation card on hover or focus (dotted underline, a focus stop for the keyboard). */
export function Info(props: InfoProps): JSX.Element {
    const key: string = props.tipKey;
    const show = (): void => {
        showInfo(key, props.title, props.lines);
    };
    const hide = (): void => {
        hideTip(key);
    };
    return (
        <span
            tabIndex={0}
            class={`tipped${props.class === undefined ? '' : ` ${props.class}`}${anchorClass(key)}`}
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={show}
            onBlur={hide}
        >
            {props.children}
        </span>
    );
}

/** The app's one tooltip layer: fixed, placed against the anchor by CSS, flipped to stay on screen. */
export function ItemTip(): JSX.Element | null {
    const t: TipState | null = tip.value;
    if (t === null) {
        return null;
    }
    const c = t.content;
    return (
        <div class="item-tip" role="tooltip">
            {c.kind === 'item' ? (
                <ItemCard view={c.view} />
            ) : (
                <div class="info-card">
                    <p class="info-title">{c.title}</p>
                    {c.lines.map((l: string, k: number) => (
                        <p key={k}>{l}</p>
                    ))}
                </div>
            )}
        </div>
    );
}
