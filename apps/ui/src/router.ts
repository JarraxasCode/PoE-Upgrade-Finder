// The current route as a signal, kept in step with location.hash.

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { parseRoute, routeHash } from './routes.ts';
import type { Route } from './routes.ts';

export const route: Signal<Route> = signal<Route>(parseRoute(window.location.hash));

window.addEventListener('hashchange', () => {
    route.value = parseRoute(window.location.hash);
});

export function go(to: Route): void {
    window.location.hash = routeHash(to);
}
