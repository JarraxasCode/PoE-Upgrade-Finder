// The engine sends non-finite numbers as strings, because JSON can't carry them (PLAN.md, Engine, Protocol).
// EHP and max-hit values can be infinite in PoB.

export type EngineNumber = number | 'Infinity' | '-Infinity' | 'NaN';

/** A stat value as the engine sends it: a number, a non-finite number as a string, or a PoB flag. */
export type EngineValue = EngineNumber | boolean;

const NON_FINITE: ReadonlyMap<string, number> = new Map<string, number>([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
]);

export function isEngineNumber(value: unknown): value is EngineNumber {
    return typeof value === 'number' || (typeof value === 'string' && NON_FINITE.has(value));
}

export function isEngineValue(value: unknown): value is EngineValue {
    return typeof value === 'boolean' || isEngineNumber(value);
}

/** Turns an engine number into a JS number (Infinity, -Infinity or NaN for the string forms). */
export function toNumber(value: EngineNumber): number {
    if (typeof value === 'number') {
        return value;
    }
    const decoded: number | undefined = NON_FINITE.get(value);
    if (decoded === undefined) {
        throw new TypeError(`not an engine number: ${String(value)}`);
    }
    return decoded;
}
