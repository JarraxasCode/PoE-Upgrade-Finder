// Where the engine's pieces live, and the command that starts a real worker.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineCommand } from './process.ts';

/** The environment variable naming the PoB copy (repo layout: runtime\ and src\), e.g. a PoB Community checkout or a copy built by tools/pob-update. */
export const POB_DIR_ENV: string = 'POE_UF_POB_DIR';

/**
 * Set to 1 to make a missing PoB copy (or luahost.exe) fail the golden tests instead of skipping them
 * (test/golden/engine.ts). `npm run check` sets it (tools/check/check.ts); a plain `npm test` doesn't.
 */
export const REQUIRE_POB_ENV: string = 'POE_UF_REQUIRE_POB';

export interface EnginePaths {
    /** engine/host/bin/luahost.exe (built by engine/host/build.ps1). */
    readonly luahostPath: string;
    /** engine/lua/dispatcher.lua. */
    readonly dispatcherPath: string;
    /** A PoB copy in repo layout, with runtime\ (lua51.dll) and src\ (HeadlessWrapper.lua). */
    readonly pobDir: string;
}

/**
 * The app root: the nearest folder above this file holding engine/lua/dispatcher.lua. That is the repo root
 * in dev (packages/engine-client/src) and resources/app in the packaged app, where main is one bundle
 * (apps/desktop/dist/main.mjs) and import.meta points there instead.
 */
export function repoRoot(): string {
    let dir: string = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(join(dir, 'engine', 'lua', 'dispatcher.lua'))) {
            return dir;
        }
        const parent: string = dirname(dir);
        if (parent === dir) {
            throw new Error(`no engine/lua/dispatcher.lua above ${fileURLToPath(import.meta.url)}`);
        }
        dir = parent;
    }
}

/**
 * The pinned PoB copy built by tools/pob-update: engine/pob/<version>, the version read from
 * engine/pob-pin.json. Undefined when the pin or the folder is missing.
 */
export function pinnedPobDir(root: string = repoRoot()): string | undefined {
    let version: unknown;
    try {
        const pin: unknown = JSON.parse(readFileSync(join(root, 'engine', 'pob-pin.json'), 'utf8'));
        version = typeof pin === 'object' && pin !== null && 'version' in pin ? pin.version : undefined;
    } catch {
        return undefined;
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
        return undefined;
    }
    const dir: string = join(root, 'engine', 'pob', version);
    return existsSync(join(dir, 'src', 'HeadlessWrapper.lua')) ? dir : undefined;
}

/**
 * Resolves the engine paths. The PoB copy comes from `pobDir`, else the POE_UF_POB_DIR environment variable,
 * else the pinned copy (pinnedPobDir).
 * Throws with a message saying what's missing.
 */
export function resolveEnginePaths(pobDir?: string): EnginePaths {
    const root: string = repoRoot();
    const pob: string | undefined = pobDir ?? process.env[POB_DIR_ENV] ?? pinnedPobDir(root);
    if (pob === undefined || pob === '') {
        throw new Error(`no PoB copy given: pass its folder or set ${POB_DIR_ENV} (a folder with runtime\\ and src\\)`);
    }
    const paths: EnginePaths = {
        luahostPath: join(root, 'engine', 'host', 'bin', 'luahost.exe'),
        dispatcherPath: join(root, 'engine', 'lua', 'dispatcher.lua'),
        pobDir: resolve(pob),
    };
    if (!existsSync(paths.luahostPath)) {
        throw new Error(`${paths.luahostPath} is missing: build it with powershell -File engine\\host\\build.ps1`);
    }
    if (!existsSync(join(paths.pobDir, 'runtime', 'lua51.dll')) || !existsSync(join(paths.pobDir, 'src', 'HeadlessWrapper.lua'))) {
        throw new Error(`${paths.pobDir} is not a PoB copy in repo layout (needs runtime\\lua51.dll and src\\HeadlessWrapper.lua)`);
    }
    return paths;
}

/** The command that starts a real worker: luahost running the dispatcher from PoB's src folder. */
export function luahostCommand(paths: EnginePaths, gcEvery?: number): EngineCommand {
    const runtime: string = join(paths.pobDir, 'runtime');
    const args: string[] = [runtime, join(paths.pobDir, 'src'), paths.dispatcherPath];
    if (gcEvery !== undefined) {
        args.push(`--gc-every=${gcEvery}`);
    }
    return {
        command: paths.luahostPath,
        args: args,
        env: {
            LUA_PATH: '../runtime/lua/?.lua;../runtime/lua/?/init.lua;./?.lua;;',
            LUA_CPATH: join(runtime, '?.dll'),
        },
    };
}
