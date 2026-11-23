// Editing FloorSettings one entry at a time (the Settings form). Pure, so it is unit-tested. An entry that
// is unset is off; numbers are kept when ticked on again via the defaults given by the form.

import type { Element, FloorSettings } from '@poe-upgrade-finder/ipc';

export type NumberFloor = 'chaosResMin' | 'spellBlockMin';
export type BoolFloor = 'elementalResCapped' | 'attributesMet' | 'flagLifeLoss' | 'flagNetRegen';
export type PerElementFloor = 'maxResMin';
export type TargetNumber = 'chaosRes' | 'overcapMin';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function setNumber(f: FloorSettings, key: NumberFloor, value: number | undefined): FloorSettings {
    const out: Mutable<FloorSettings> = { ...f };
    if (value === undefined) {
        delete out[key];
    } else {
        out[key] = value;
    }
    return out;
}

export function setBool(f: FloorSettings, key: BoolFloor, value: boolean): FloorSettings {
    const out: Mutable<FloorSettings> = { ...f };
    if (value) {
        out[key] = true;
    } else {
        delete out[key];
    }
    return out;
}

function withElement(
    map: Readonly<Partial<Record<Element, number>>> | undefined,
    el: Element,
    value: number | undefined,
): Partial<Record<Element, number>> | undefined {
    const next: Partial<Record<Element, number>> = { ...map };
    if (value === undefined) {
        delete next[el];
    } else {
        next[el] = value;
    }
    return Object.keys(next).length === 0 ? undefined : next;
}

export function setMaxResMin(f: FloorSettings, el: Element, value: number | undefined): FloorSettings {
    const out: Mutable<FloorSettings> = { ...f };
    const next = withElement(f.maxResMin, el, value);
    if (next === undefined) {
        delete out.maxResMin;
    } else {
        out.maxResMin = next;
    }
    return out;
}

type Targets = NonNullable<FloorSettings['targets']>;

function setTargets(f: FloorSettings, targets: Mutable<Targets>): FloorSettings {
    const out: Mutable<FloorSettings> = { ...f };
    if (Object.keys(targets).length === 0) {
        delete out.targets;
    } else {
        out.targets = targets;
    }
    return out;
}

export function setTargetNumber(f: FloorSettings, key: TargetNumber, value: number | undefined): FloorSettings {
    const t: Mutable<Targets> = { ...f.targets };
    if (value === undefined) {
        delete t[key];
    } else {
        t[key] = value;
    }
    return setTargets(f, t);
}

export function setTargetMaxRes(f: FloorSettings, el: Element, value: number | undefined): FloorSettings {
    const t: Mutable<Targets> = { ...f.targets };
    const next = withElement(f.targets?.maxRes, el, value);
    if (next === undefined) {
        delete t.maxRes;
    } else {
        t.maxRes = next;
    }
    return setTargets(f, t);
}

/** A number box's text → a number, or undefined when it isn't one. */
export function parseNumberText(text: string): number | undefined {
    if (text.trim() === '') {
        return undefined;
    }
    const n: number = Number(text);
    return Number.isFinite(n) ? n : undefined;
}
