// Small runtime checks for JSON coming in at the boundaries (engine messages, trade responses, GGG's
// currency digests). Each one throws a ValidationError naming the path of the bad value, so a malformed
// message says exactly what was wrong.

export class ValidationError extends Error {
    public override readonly name: string = 'ValidationError';
}

export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'an array';
    }
    return typeof value;
}

export function record(value: unknown, path: string): JsonRecord {
    if (!isRecord(value)) {
        throw new ValidationError(`${path}: expected an object, got ${describe(value)}`);
    }
    return value;
}

export function string(value: unknown, path: string): string {
    if (typeof value !== 'string') {
        throw new ValidationError(`${path}: expected a string, got ${describe(value)}`);
    }
    return value;
}

export function number(value: unknown, path: string): number {
    if (typeof value !== 'number') {
        throw new ValidationError(`${path}: expected a number, got ${describe(value)}`);
    }
    return value;
}

export function boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
        throw new ValidationError(`${path}: expected a boolean, got ${describe(value)}`);
    }
    return value;
}

export function optional<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): T | undefined {
    return value === undefined || value === null ? undefined : read(value, path);
}

/** An array. The engine encodes an empty array as {} when it can't tell, so an empty object is accepted too. */
export function array<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): readonly T[] {
    if (isRecord(value) && Object.keys(value).length === 0) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new ValidationError(`${path}: expected an array, got ${describe(value)}`);
    }
    return value.map((item: unknown, i: number) => read(item, `${path}[${i}]`));
}

export function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    const s: string = string(value, path);
    const found: T | undefined = allowed.find((a: T) => a === s);
    if (found === undefined) {
        throw new ValidationError(`${path}: expected one of ${allowed.join(', ')}, got ${s}`);
    }
    return found;
}
