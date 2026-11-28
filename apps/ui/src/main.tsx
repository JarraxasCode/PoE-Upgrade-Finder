// The renderer's entry point. data-ready on <html> tells the smoke check (and nothing else) that the first
// render and the first round of calls to main are done.

import { render } from 'preact';
import type { MainEvent } from '@poe-upgrade-finder/ipc';
import { onMainEvent } from './api.ts';
import { App } from './app.tsx';
import { loadAppInfo, setPobUpdate } from './state/app-info.ts';
import { buildState, loadBuilds, selectedBuildId, setBuildsList } from './state/builds.ts';
import { notify } from './state/notices.ts';
import { loadSettings } from './state/settings.ts';
import { applyRunEvent, limits, loadRun } from './state/run.ts';
import { loadTradeState, rate, signIn } from './state/trade.ts';
import './styles.css';

const root: HTMLElement | null = document.getElementById('app');
if (root === null) {
    throw new Error('index.html has no #app element');
}

onMainEvent((event: MainEvent) => {
    switch (event.kind) {
        case 'builds-changed':
            setBuildsList(event.list);
            break;
        case 'build-state':
            buildState.value = event.state;
            break;
        case 'signin-state':
            signIn.value = event.state;
            break;
        case 'rate-state':
            rate.value = event.state;
            break;
        case 'limits':
            limits.value = event.panel;
            break;
        case 'pob-state':
            setPobUpdate(event.state);
            break;
        case 'run-started':
        case 'run-phase':
        case 'run-search':
        case 'run-item':
        case 'run-band-done':
        case 'run-feed':
        case 'run-done':
        case 'run-deepen':
            applyRunEvent(event);
            break;
        case 'notice':
            notify(event.level, event.message);
            break;
        default: {
            // Every event kind must be routed: a new one fails to compile here.
            const unrouted: never = event;
            void unrouted;
        }
    }
});

render(<App />, root);

/** Resolves when PoB has finished with the first build (or there is none), for the smoke check. */
function settled(): Promise<void> {
    return new Promise<void>((done: () => void) => {
        const check = (): void => {
            const kind: string = buildState.value.kind;
            if (kind === 'ready' || kind === 'error' || (kind === 'none' && selectedBuildId.value === null)) {
                done();
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

void Promise.allSettled([loadAppInfo(), loadSettings(), loadTradeState(), loadRun(), loadBuilds()])
    .then(settled)
    .finally(() => {
        document.documentElement.dataset['ready'] = '1';
    });
