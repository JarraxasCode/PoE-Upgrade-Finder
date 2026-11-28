// Packages v1 as one exe (PLAN.md, "Phase 5: shipping"):
//
//   node tools/package/package.ts            → out/package/poe-upgrade-finder-<version>.exe
//   node tools/package/package.ts --zip-only → out/package/app-<version>.zip (no launcher)
//
// 1. Checks the pinned PoB copy (engine/pob/<version>, from engine/pob-pin.json) against its manifest.
// 2. Builds the renderer and the preload (tools/build-ui), and bundles main into one ESM file with esbuild
//    (Node won't strip types under node_modules, so the .ts workspace packages can't ship as they are).
// 3. Streams the app into one zip, laid out as Electron's dist with the app in resources/app:
//      poe-upgrade-finder.exe            electron.exe, cookie-encryption fuse on, RunAsNode off
//      <Electron's other files>          default_app.asar and our fuse backup left out
//      resources/app/package.json        name, productName, version, main
//      resources/app/apps/desktop/dist/  main.mjs (the bundle), preload.cjs
//      resources/app/apps/desktop/src/data/  item art tables
//      resources/app/apps/ui/dist/       the renderer (no source maps)
//      resources/app/engine/             lua/, host/bin/luahost.exe, pob-pin.json, pob/<version>/ (LICENSE.md in it;
//                                        only the manifest's files and the headless extras, see pobFiles)
//    The app finds its root by walking up to engine/lua/dispatcher.lua, and PoB from the pin (engine-client).
// 4. Compiles tools/launcher with the in-box csc.exe, the zip embedded as a resource.
//
// Nothing is downloaded. Run it with the app closed (it reads electron.exe).

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import {
    HEADLESS_FILES,
    isSkipped,
    parseManifest,
    readPin,
    verifyCopy,
    type PobManifest,
    type PobPin,
} from '@poe-upgrade-finder/pob-update';
import { ZipWriter } from '../../apps/desktop/src/services/zip.ts';
import { type FuseName, setFuse } from '../electron-fuses/fuses.ts';
import { describeError } from '@poe-upgrade-finder/validate';

const ROOT: string = resolve(import.meta.dirname, '..', '..');
const OUT: string = join(ROOT, 'out', 'package');
const ELECTRON_DIST: string = join(ROOT, 'node_modules', 'electron', 'dist');
export const APP_EXE: string = 'poe-upgrade-finder.exe';

/** The fuses set on our copy of electron.exe; everything else in it is Electron's. */
export const APP_FUSES: readonly { readonly name: FuseName; readonly on: boolean }[] = [
    { name: 'EnableCookieEncryption', on: true },
    { name: 'RunAsNode', on: false },
];

/** Electron's exe as we ship it: the fuses above set on a copy. */
export function appExe(electronExe: Buffer): Buffer {
    const exe: Buffer = Buffer.from(electronExe);
    for (const fuse of APP_FUSES) {
        setFuse(exe, fuse.name, fuse.on);
    }
    return exe;
}

/**
 * The PoB files that ship: the manifest's files (less tree images and assets, which headless PoB never
 * opens), the headless extras, and manifest.xml itself (the in-app update reads it). Anything else in the
 * copy is left out: PoB writes caches there during dev runs (v0.2.0 shipped a TimelessJewelData .bin).
 */
export function pobFiles(manifest: PobManifest): readonly string[] {
    const listed: string[] = manifest.files.map((f) => f.path).filter((p: string) => !isSkipped(p));
    return [...listed, ...HEADLESS_FILES, 'manifest.xml'];
}

interface ZipSource {
    /** Name inside the zip, forward slashes. */
    readonly name: string;
    readonly path?: string;
    readonly data?: Buffer;
}

function readJson(path: string): Readonly<Record<string, unknown>> {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${path}: expected an object`);
    }
    return value as Readonly<Record<string, unknown>>;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string, where: string): string {
    const value: unknown = record[key];
    if (typeof value !== 'string') {
        throw new Error(`${where}: ${key} is not a string`);
    }
    return value;
}

/** Every file under `dir`, as zip sources named `prefix` + the relative path. */
function tree(dir: string, prefix: string, skip: (rel: string) => boolean = () => false): ZipSource[] {
    const found: ZipSource[] = [];
    const walk = (at: string): void => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
            const full: string = join(at, entry.name);
            const rel: string = relative(dir, full).replaceAll('\\', '/');
            if (skip(rel)) {
                continue;
            }
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                found.push({ name: prefix + rel, path: full });
            }
        }
    };
    walk(dir);
    return found;
}

function run(command: string, args: readonly string[]): void {
    const result: SpawnSyncReturns<Buffer> = spawnSync(command, [...args], { cwd: ROOT, stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal ?? '?'})`);
    }
}

function mb(bytes: number): string {
    return `${(bytes / 1e6).toFixed(0)} MB`;
}

async function main(): Promise<number> {
    const { values } = parseArgs({ options: { 'zip-only': { type: 'boolean' } } });
    const started: number = Date.now();
    const desktop: Readonly<Record<string, unknown>> = readJson(join(ROOT, 'apps', 'desktop', 'package.json'));
    const version: string = stringField(desktop, 'version', 'apps/desktop/package.json');
    const productName: string = stringField(desktop, 'productName', 'apps/desktop/package.json');

    // 1. The pinned PoB copy.
    const pin: PobPin = await readPin(join(ROOT, 'engine', 'pob-pin.json'));
    const pobDir: string = join(ROOT, 'engine', 'pob', pin.version);
    if (!existsSync(join(pobDir, 'manifest.xml'))) {
        throw new Error(`${pobDir} is missing: build it with tools/pob-update (--tag ${pin.tag})`);
    }
    const manifest: PobManifest = parseManifest(readFileSync(join(pobDir, 'manifest.xml'), 'utf8'));
    const bad: readonly string[] = await verifyCopy(pobDir, manifest, true);
    if (bad.length > 0) {
        throw new Error(`the PoB copy doesn't match its manifest: ${bad.slice(0, 5).join(', ')}`);
    }
    if (!existsSync(join(pobDir, 'LICENSE.md'))) {
        throw new Error('PoB LICENSE.md is missing');
    }
    const luahost: string = join(ROOT, 'engine', 'host', 'bin', 'luahost.exe');
    if (!existsSync(luahost)) {
        throw new Error('luahost.exe is missing: powershell -File engine\\host\\build.ps1');
    }
    console.log(`PoB ${pin.version} (${pin.commit.slice(0, 7)}) checked`);

    // 2. Renderer + preload, then the main bundle.
    run(process.execPath, [join(ROOT, 'tools', 'build-ui', 'build.ts')]);
    const bundleDir: string = join(OUT, 'bundle');
    rmSync(bundleDir, { recursive: true, force: true });
    await build({
        entryPoints: [join(ROOT, 'apps', 'desktop', 'src', 'main.ts')],
        outfile: join(bundleDir, 'main.mjs'),
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        external: ['electron'],
        resolveExtensions: ['.ts', '.js'],
        legalComments: 'none',
        sourcemap: false,
        logLevel: 'warning',
    });

    // 3. The zip.
    const exe: Buffer = appExe(readFileSync(join(ELECTRON_DIST, 'electron.exe')));
    const appPackage: Buffer = Buffer.from(
        `${JSON.stringify({ name: productName, productName: productName, version: version, private: true, type: 'module', main: 'apps/desktop/dist/main.mjs' }, null, 2)}\n`,
    );
    const app: string = 'resources/app/';
    const sources: ZipSource[] = [
        { name: APP_EXE, data: exe },
        ...tree(ELECTRON_DIST, '', (rel: string) => rel.startsWith('electron.exe') || rel === 'resources/default_app.asar'),
        { name: `${app}package.json`, data: appPackage },
        { name: `${app}apps/desktop/dist/main.mjs`, path: join(bundleDir, 'main.mjs') },
        { name: `${app}apps/desktop/dist/preload.cjs`, path: join(ROOT, 'apps', 'desktop', 'dist', 'preload.cjs') },
        ...tree(join(ROOT, 'apps', 'desktop', 'src', 'data'), `${app}apps/desktop/src/data/`),
        ...tree(join(ROOT, 'apps', 'ui', 'dist'), `${app}apps/ui/dist/`, (rel: string) => rel.endsWith('.map')),
        ...tree(join(ROOT, 'engine', 'lua'), `${app}engine/lua/`),
        { name: `${app}assets/icon/icon.ico`, path: join(ROOT, 'assets', 'icon', 'icon.ico') },
        { name: `${app}engine/host/bin/luahost.exe`, path: luahost },
        { name: `${app}engine/pob-pin.json`, path: join(ROOT, 'engine', 'pob-pin.json') },
        ...pobFiles(manifest).map((p: string) => ({ name: `${app}engine/pob/${pin.version}/${p}`, path: join(pobDir, p) })),
    ];
    const strays: readonly string[] = tree(pobDir, '')
        .map((s: ZipSource) => s.name)
        .filter((n: string) => !pobFiles(manifest).includes(n));
    if (strays.length > 0) {
        console.log(`left out of the PoB copy (not in its manifest): ${strays.join(', ')}`);
    }
    for (const source of sources) {
        if (source.name.includes('..') || source.name.includes('\\')) {
            throw new Error(`bad zip name ${source.name}`);
        }
    }
    mkdirSync(OUT, { recursive: true });
    const zipPath: string = join(OUT, `app-${version}.zip`);
    const fd: number = openSync(zipPath, 'w');
    let raw: number = 0;
    try {
        const writer: ZipWriter = new ZipWriter((chunk: Buffer) => {
            writeSync(fd, chunk);
        });
        for (const source of sources) {
            const data: Buffer = source.data ?? readFileSync(source.path ?? '');
            raw += data.length;
            writer.add({ name: source.name, data: data });
        }
        writer.finish();
    } finally {
        closeSync(fd);
    }
    console.log(`zip: ${sources.length} files, ${mb(raw)} → ${mb(statSync(zipPath).size)}`);
    if (values['zip-only'] === true) {
        return 0;
    }

    // 4. The launcher.
    const csc: string = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const launcherDir: string = join(ROOT, 'tools', 'launcher');
    const info: string = join(OUT, 'BuildInfo.g.cs');
    writeFileSync(
        info,
        `// Generated by tools/package/package.ts.\nnamespace PoeUpgradeFinder.Launcher {\n    internal static class BuildInfo {\n` +
            `        public const string Version = "${version}";\n` +
            `        public const string BuildId = "${version}+${new Date(started).toISOString()}";\n` +
            `        public const string AppExe = "${APP_EXE}";\n    }\n}\n`,
    );
    const exeOut: string = join(OUT, `${productName}-${version}.exe`);
    run(csc, [
        '/nologo',
        '/optimize+',
        '/platform:x64',
        '/target:winexe',
        `/out:${exeOut}`,
        `/win32manifest:${join(launcherDir, 'app.manifest')}`,
        `/win32icon:${join(ROOT, 'assets', 'icon', 'icon.ico')}`,
        '/reference:System.IO.Compression.dll',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll',
        `/resource:${zipPath},app.zip`,
        join(launcherDir, 'Launcher.cs'),
        info,
    ]);
    console.log(`${exeOut}: ${mb(statSync(exeOut).size)}, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    return 0;
}

if (import.meta.main) {
    main().then(
        (code: number) => {
            process.exitCode = code;
        },
        (error: unknown) => {
            console.error(describeError(error));
            process.exitCode = 1;
        },
    );
}
