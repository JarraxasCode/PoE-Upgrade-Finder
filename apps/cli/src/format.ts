import type { Price } from './listings.ts';

/** A plain text table; `right[i]` right-aligns column i. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[], right: readonly boolean[]): string {
    const widths: number[] = headers.map((h: string, i: number) =>
        Math.max(h.length, ...rows.map((r: readonly string[]) => (r[i] ?? '').length)),
    );
    const line = (cells: readonly string[]): string =>
        cells
            .map((c: string, i: number) => (right[i] ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
            .join('  ')
            .trimEnd();
    return `${[line(headers), line(widths.map((w: number) => '-'.repeat(w))), ...rows.map(line)].join('\n')}\n`;
}

export function signed(n: number, digits: number): string {
    if (Number.isNaN(n)) {
        return 'n/a';
    }
    if (!Number.isFinite(n)) {
        return n > 0 ? '+inf' : '-inf';
    }
    const text: string = n.toFixed(digits);
    return n > 0 ? `+${text}` : text === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : text;
}

export function pct(n: number | undefined): string {
    return n === undefined ? '' : signed(n, 2);
}

export function formatPrice(price: Price | undefined): string {
    return price ? `${price.amount} ${price.currency}` : '';
}
