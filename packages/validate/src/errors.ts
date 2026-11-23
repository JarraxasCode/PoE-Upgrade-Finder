// Turning a caught `unknown` into something to show or log. `catch (error: unknown)` can hold anything a
// promise rejected with, not only an Error.

/** The error's message, or the thrown value as text. */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The error itself, or the thrown value wrapped in one (for a reject() that wants an Error). */
export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/** The stack for a log line, or null when the thrown value has none. */
export function stackOf(error: unknown): string | null {
    return error instanceof Error ? (error.stack ?? null) : null;
}

/** The stack when there is one, else the message: for a fatal error printed to stderr. */
export function describeError(error: unknown): string {
    return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
