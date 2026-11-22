// The app shell (PLAN.md, UI): a left rail and one view per route. Later features each add a rail entry
// and a route without changing the views.

import type { ComponentChildren, JSX, TargetedMouseEvent } from 'preact';
import { go, route } from './router.ts';
import type { Route } from './routes.ts';
import { AccountBadge } from './views/account-badge.tsx';
import { ItemTip } from './views/item-card.tsx';
import { RunView } from './views/run-view.tsx';
import { SearchView } from './views/search-view.tsx';
import { SettingsView } from './views/settings-view.tsx';

interface RailLinkProps {
    readonly to: Route;
    readonly icon: string;
    readonly children: ComponentChildren;
}

function RailLink(props: RailLinkProps): JSX.Element {
    const on: boolean = route.value === props.to;
    return (
        <a
            href={`#/${props.to}`}
            class={on ? 'on' : undefined}
            aria-current={on ? 'page' : undefined}
            onClick={(e: TargetedMouseEvent<HTMLAnchorElement>) => {
                e.preventDefault();
                go(props.to);
            }}
        >
            <span class="rail-icon" aria-hidden="true">{props.icon}</span>
            {props.children}
        </a>
    );
}

function CurrentView(): JSX.Element {
    switch (route.value) {
        case 'search':
            return <SearchView />;
        case 'run':
            return <RunView />;
        case 'settings':
            return <SettingsView />;
    }
}

export function App(): JSX.Element {
    return (
        <div class="shell">
            <nav class="rail" aria-label="Main">
                <img class="logo" src="icon.svg" alt="" aria-hidden="true" />
                <AccountBadge />
                <RailLink to="search" icon="⌕">Search</RailLink>
                <RailLink to="run" icon="▶">Run</RailLink>
                <RailLink to="settings" icon="⚙">Settings</RailLink>
            </nav>
            <main class="view">
                <CurrentView />
            </main>
            <ItemTip />
        </div>
    );
}
