// Reads or turns on Electron's EnableCookieEncryption fuse in the workspace's electron.exe (PLAN.md, D10 and
// V15: cookies are stored in plain text unless it's on; it's off by default).
//
//   node tools/electron-fuses/fuses.ts read
//   node tools/electron-fuses/fuses.ts enable-cookie-encryption   (backs up electron.exe first)
//
// Run it with the app closed. Turning cookie encryption on is one-way for a cookie store: cookies are
// encrypted when next written, and turning it off again leaves the store unreadable. Re-run it after any
// reinstall of electron (npm install replaces the binary). Ported from spike/tools/fuses.js.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FUSE_SENTINEL: string = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FUSE_NAMES_V1: readonly string[] = [
    'RunAsNode',
    'EnableCookieEncryption',
    'EnableNodeOptionsEnvironmentVariable',
    'EnableNodeCliInspectArguments',
    'EnableEmbeddedAsarIntegrityValidation',
    'OnlyLoadAppFromAsar',
    'LoadBrowserProcessSpecificV8Snapshot',
    'GrantFileProtocolExtraPrivileges',
    'WasmTrapHandlers',
];

export interface FuseWire {
    readonly offset: number;
    readonly version: number;
    readonly wire: string;
    readonly fuses: Readonly<Record<string, string>>;
}

export function readFuseWire(buffer: Buffer): FuseWire | undefined {
    const at: number = buffer.indexOf(Buffer.from(FUSE_SENTINEL, 'latin1'));
    if (at < 0) {
        return undefined;
    }
    const versionAt: number = at + FUSE_SENTINEL.length;
    const version: number = buffer[versionAt] ?? 0;
    const length: number = buffer[versionAt + 1] ?? 0;
    const wire: string = buffer.subarray(versionAt + 2, versionAt + 2 + length).toString('latin1');
    const fuses: Record<string, string> = {};
    for (let i: number = 0; i < wire.length; i++) {
        const name: string = version === 1 ? (FUSE_NAMES_V1[i] ?? `fuse${i}`) : `fuse${i}`;
        const c: string | undefined = wire[i];
        fuses[name] = c === '1' ? 'on' : c === '0' ? 'off' : c === 'r' ? 'removed' : `?${c ?? ''}`;
    }
    return { offset: versionAt + 2, version: version, wire: wire, fuses: fuses };
}

export type FuseName = 'RunAsNode' | 'EnableCookieEncryption';

/**
 * Sets one fuse in an Electron binary's bytes, in place. Returns whether it changed. Throws on a wire it
 * doesn't know (an unknown version, or a byte that isn't 0 or 1), rather than guess.
 */
export function setFuse(buffer: Buffer, name: FuseName, on: boolean): boolean {
    const state: FuseWire | undefined = readFuseWire(buffer);
    if (state === undefined) {
        throw new Error('fuse sentinel not found');
    }
    if (state.version !== 1) {
        throw new Error(`unknown fuse wire version ${state.version}`);
    }
    const index: number = FUSE_NAMES_V1.indexOf(name);
    const current: string | undefined = state.wire[index];
    if (current !== '0' && current !== '1') {
        throw new Error(`unexpected fuse byte "${current ?? ''}" for ${name}`);
    }
    const wanted: string = on ? '1' : '0';
    if (current === wanted) {
        return false;
    }
    buffer[state.offset + index] = wanted.charCodeAt(0);
    return true;
}

function main(command: string | undefined): number {
    const root: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const exe: string = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    const backup: string = `${exe}.no-cookie-encryption.bak`;
    const buffer: Buffer = readFileSync(exe);
    const state: FuseWire | undefined = readFuseWire(buffer);
    if (state === undefined) {
        process.stderr.write(`fuse sentinel not found in ${exe}\n`);
        return 1;
    }
    if (command === undefined || command === 'read') {
        process.stdout.write(`${JSON.stringify({ binary: exe, version: state.version, wire: state.wire, fuses: state.fuses, backupExists: existsSync(backup) }, null, 2)}\n`);
        return 0;
    }
    if (command !== 'enable-cookie-encryption') {
        process.stderr.write(`unknown command ${command}: read or enable-cookie-encryption\n`);
        return 64;
    }
    const index: number = FUSE_NAMES_V1.indexOf('EnableCookieEncryption');
    if (state.version !== 1) {
        process.stderr.write(`unknown fuse wire version ${state.version}; not flipping\n`);
        return 1;
    }
    if (state.wire[index] === '1') {
        process.stdout.write('EnableCookieEncryption is already on.\n');
        return 0;
    }
    if (state.wire[index] !== '0') {
        process.stderr.write(`unexpected fuse byte "${state.wire[index] ?? ''}"; not flipping\n`);
        return 1;
    }
    if (!existsSync(backup)) {
        copyFileSync(exe, backup);
        process.stdout.write(`Backed up to ${backup}\n`);
    }
    buffer[state.offset + index] = '1'.charCodeAt(0);
    writeFileSync(exe, buffer);
    const after: FuseWire | undefined = readFuseWire(readFileSync(exe));
    process.stdout.write(`EnableCookieEncryption: ${state.fuses['EnableCookieEncryption'] ?? '?'} -> ${after?.fuses['EnableCookieEncryption'] ?? '?'} (wire ${state.wire} -> ${after?.wire ?? '?'})\n`);
    return 0;
}

// Only when run as a script: tools/package imports setFuse.
if (import.meta.main) {
    process.exitCode = main(process.argv[2]);
}
