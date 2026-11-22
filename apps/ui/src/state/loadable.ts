/** A value loaded from main: still loading, ready, or failed with a message for the user. */
export type Loadable<T> =
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly value: T }
    | { readonly kind: 'error'; readonly message: string };

export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function readyValue<T>(l: Loadable<T>): T | undefined {
    return l.kind === 'ready' ? l.value : undefined;
}
