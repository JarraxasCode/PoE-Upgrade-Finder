// The budget as typed on the Search view: "300" or "300c" (chaos), "1.5d" (divines). Shared, so the form
// and main read it the same way. Pure.

export type BudgetUnit = 'chaos' | 'divine';

export interface Budget {
    readonly amount: number;
    readonly unit: BudgetUnit;
}

/** Undefined when it isn't a budget. */
export function parseBudgetText(text: string): Budget | undefined {
    const match: RegExpExecArray | null = /^\s*(\d+(?:\.\d+)?)\s*(c|chaos|d|div|divine|divines)?\s*$/i.exec(text);
    const amount: number = Number(match?.[1]);
    if (match === null || !(amount > 0) || !Number.isFinite(amount)) {
        return undefined;
    }
    const unit: string = (match[2] ?? 'c').toLowerCase();
    return { amount: amount, unit: unit.startsWith('d') ? 'divine' : 'chaos' };
}

export function budgetLabel(budget: Budget): string {
    return budget.unit === 'chaos' ? `${budget.amount}c` : `${budget.amount} div`;
}
