// A listing's price with the currency's own icon (chaos and divine orbs, from GGG's CDN like the item images),
// and what it is in the other currency at the run's divine rate on hover.

import type { JSX } from 'preact';
import type { UiPrice } from '@poe-upgrade-finder/ipc';
import { Info } from './item-card.tsx';

const ORBS: Readonly<Record<string, { readonly icon: string; readonly name: string }>> = {
    chaos: { icon: 'https://web.poecdn.com/image/Art/2DItems/Currency/CurrencyRerollRare.png', name: 'Chaos Orb' },
    divine: { icon: 'https://web.poecdn.com/image/Art/2DItems/Currency/CurrencyModValues.png', name: 'Divine Orb' },
};

function amountText(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1).replace(/\.?0+$/, '');
}

/** "5" and a chaos orb; a currency without an icon keeps its name. */
export function Orb(props: { readonly currency: string; readonly amount: number }): JSX.Element {
    const orb = ORBS[props.currency];
    return (
        <span class="price">
            <span class="num">{amountText(props.amount)}</span>
            {orb === undefined ? <span> {props.currency}</span> : <img class="orb" src={orb.icon} alt={orb.name} title={orb.name} />}
        </span>
    );
}

interface PriceProps {
    readonly tipKey: string;
    readonly price: UiPrice | null;
    /** The price in chaos at the run's rate (null for currencies other than chaos and divine). */
    readonly chaos: number | null;
    readonly chaosPerDivine: number | null;
}

export function Price(props: PriceProps): JSX.Element {
    const p: UiPrice | null = props.price;
    if (p === null) {
        return <span class="muted">no price</span>;
    }
    const lines: string[] = [];
    if (props.chaosPerDivine !== null && props.chaos !== null) {
        lines.push(
            p.currency === 'divine'
                ? `About ${Math.round(props.chaos)} chaos at ${props.chaosPerDivine.toFixed(1)} chaos per divine.`
                : `About ${(props.chaos / props.chaosPerDivine).toFixed(3)} divine at ${props.chaosPerDivine.toFixed(1)} chaos per divine.`,
        );
    }
    lines.push("The seller's listed price. Bands, the budget and the chart use the chaos figure.");
    return (
        <Info
            tipKey={props.tipKey}
            title={`${amountText(p.amount)} ${ORBS[p.currency]?.name ?? p.currency}${p.amount === 1 ? '' : 's'}`}
            lines={lines}
        >
            <Orb currency={p.currency} amount={p.amount} />
        </Info>
    );
}
