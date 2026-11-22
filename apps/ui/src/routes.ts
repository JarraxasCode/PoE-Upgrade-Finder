// The views (PLAN.md, UI: Search, the Run view and Settings; later features each add a route). Pure, so
// it is unit-tested without a DOM.

export type Route = 'search' | 'run' | 'settings';

export const ROUTES: readonly Route[] = ['search', 'run', 'settings'];

export const DEFAULT_ROUTE: Route = 'search';

/** "#/settings" → "settings"; anything unknown → the default. */
export function parseRoute(hash: string): Route {
    const name: string = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
    const found: Route | undefined = ROUTES.find((r: Route) => r === name);
    return found ?? DEFAULT_ROUTE;
}

export function routeHash(route: Route): string {
    return `#/${route}`;
}
