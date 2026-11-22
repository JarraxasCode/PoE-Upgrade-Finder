// Number and time formats for the views. Pure (no DOM), so they are unit-tested.

import type { BuildEntry } from '@poe-upgrade-finder/ipc';

const GROUPED: Intl.NumberFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** 1,840,000 → "1.84M"; 96,412 → "96.4k"; 7,412 → "7,412" (exact under 10k). */
export function compact(n: number): string {
    const abs: number = Math.abs(n);
    if (abs >= 1e9) {
        return `${trim(n / 1e9, 2)}B`;
    }
    if (abs >= 1e6) {
        return `${trim(n / 1e6, 2)}M`;
    }
    if (abs >= 1e4) {
        return `${trim(n / 1e3, 1)}k`;
    }
    return GROUPED.format(n);
}

function trim(n: number, digits: number): string {
    return n.toFixed(digits).replace(/\.?0+$/, '');
}

export function grouped(n: number): string {
    return GROUPED.format(n);
}

/** "+1.65%", "-0.40%". */
export function signedPct(n: number, digits: number = 2): string {
    return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago". */
export function ago(thenMs: number, nowMs: number): string {
    const s: number = Math.max(0, (nowMs - thenMs) / 1000);
    if (s < 60) {
        return 'just now';
    }
    if (s < 3600) {
        return `${Math.floor(s / 60)} min ago`;
    }
    if (s < 86400) {
        return `${Math.floor(s / 3600)} h ago`;
    }
    const days: number = Math.floor(s / 86400);
    return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** "Example RF · Chieftain 94". */
export function buildLabel(b: BuildEntry): string {
    const who: string | null = b.ascendClassName ?? b.className;
    const parts: string[] = [b.name];
    if (who !== null || b.level !== null) {
        parts.push([who, b.level].filter((x) => x !== null).join(' '));
    }
    return parts.join(' · ');
}
