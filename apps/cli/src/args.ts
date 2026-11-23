import { GEAR_SLOTS, isGearSlot } from '@poe-upgrade-finder/engine-client';
import type { GearSlot, TargetRequest } from '@poe-upgrade-finder/engine-client';

export class UsageError extends Error {
    public override readonly name: string = 'UsageError';
}

/** "saved" (default), "full", or "skill:<group>.<activeSkill>[.<part>]" with PoB's 1-based indices. */
export function parseTarget(text: string | undefined): TargetRequest {
    if (text === undefined || text === 'saved') {
        return { kind: 'saved' };
    }
    if (text === 'full') {
        return { kind: 'fullDps' };
    }
    const match: RegExpMatchArray | null = /^skill:(\d+)\.(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match?.[1] || !match[2]) {
        throw new UsageError(`bad --target ${text}: use saved, full or skill:<group>.<skill>[.<part>]`);
    }
    const group: number = Number(match[1]);
    const activeSkill: number = Number(match[2]);
    return match[3] === undefined
        ? { kind: 'skill', group: group, activeSkill: activeSkill }
        : { kind: 'skill', group: group, activeSkill: activeSkill, part: Number(match[3]) };
}

export function parseSlot(text: string | undefined): GearSlot {
    if (text === undefined) {
        throw new UsageError(`--slot is required (${GEAR_SLOTS.join(', ')})`);
    }
    const found: GearSlot | undefined = GEAR_SLOTS.find((s: GearSlot) => s.toLowerCase() === text.toLowerCase());
    if (!found || !isGearSlot(found)) {
        throw new UsageError(`bad --slot ${text}: one of ${GEAR_SLOTS.join(', ')}`);
    }
    return found;
}

export function parseBlend(text: string | undefined): number {
    if (text === undefined) {
        return 0.5;
    }
    const blend: number = Number(text);
    if (!(blend >= 0 && blend <= 1)) {
        throw new UsageError(`bad --blend ${text}: a number from 0 (EHP only) to 1 (DPS only)`);
    }
    return blend;
}

export function parsePositive(name: string, text: string | undefined, fallback: number): number {
    if (text === undefined) {
        return fallback;
    }
    const n: number = Number(text);
    if (!Number.isInteger(n) || n <= 0) {
        throw new UsageError(`bad --${name} ${text}: a whole number above 0`);
    }
    return n;
}
