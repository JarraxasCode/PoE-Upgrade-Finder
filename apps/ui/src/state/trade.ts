// Sign-in and the divine rate as the UI sees them. Main checks both once at start and pushes changes as
// events; loading here only reads the last known state (no network).

import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { RateState, SignInState } from '@poe-upgrade-finder/ipc';
import { call } from '../api.ts';
import { messageOf } from './loadable.ts';

export const signIn: Signal<SignInState> = signal<SignInState>({ status: 'unknown', message: null, checkedAtMs: null });
export const rate: Signal<RateState | null> = signal<RateState | null>(null);
/** An error from a sign-in or rate action, for the line under them. */
export const tradeError: Signal<string | null> = signal<string | null>(null);

export async function loadTradeState(): Promise<void> {
    try {
        const [s, r] = await Promise.all([call('signin.status', {}), call('rate.status', {})]);
        signIn.value = s;
        rate.value = r;
    } catch (error: unknown) {
        tradeError.value = messageOf(error);
    }
}

async function run<T>(action: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    tradeError.value = null;
    try {
        apply(await action());
    } catch (error: unknown) {
        tradeError.value = messageOf(error);
    }
}

export function openSignIn(): Promise<void> {
    return run(() => call('signin.open', {}), (s: SignInState) => {
        signIn.value = s;
    });
}

export function checkSignIn(): Promise<void> {
    return run(() => call('signin.check', {}), (s: SignInState) => {
        signIn.value = s;
    });
}

export function signOut(): Promise<void> {
    return run(() => call('signin.signOut', {}), (s: SignInState) => {
        signIn.value = s;
    });
}

const setRate = (r: RateState): void => {
    rate.value = r;
};

export function refreshRate(): Promise<void> {
    return run(() => call('rate.refresh', {}), setRate);
}

export function setManualRate(chaosPerDivine: number): Promise<void> {
    return run(() => call('rate.setManual', { chaosPerDivine: chaosPerDivine }), setRate);
}

export function useGggRate(): Promise<void> {
    return run(() => call('rate.useGgg', {}), setRate);
}
