// engine/pob-pin.json: the PoB release the app ships. Every file is fetched by `commit`, never by tag.

import { readFile } from 'node:fs/promises';
import { record, string, ValidationError } from '@poe-upgrade-finder/validate';

export interface PobPin {
    readonly version: string;
    readonly tag: string;
    readonly commit: string;
}

export function parsePin(value: unknown): PobPin {
    const r: Readonly<Record<string, unknown>> = record(value, 'pin');
    const version: string = string(r.version, 'pin.version');
    const tag: string = string(r.tag, 'pin.tag');
    const commit: string = string(r.commit, 'pin.commit');
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new ValidationError(`pin.version: expected x.y.z, got ${version}`);
    }
    if (tag !== `v${version}`) {
        throw new ValidationError(`pin.tag: expected v${version}, got ${tag}`);
    }
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new ValidationError('pin.commit: expected a 40-char sha');
    }
    return { version: version, tag: tag, commit: commit };
}

export async function readPin(path: string): Promise<PobPin> {
    return parsePin(JSON.parse(await readFile(path, 'utf8')) as unknown);
}
