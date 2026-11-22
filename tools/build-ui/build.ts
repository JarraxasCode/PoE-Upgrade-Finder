// Builds what Chromium needs (D8): the renderer (apps/ui → apps/ui/dist: app.js, app.css, index.html) and
// the sandboxed preload (apps/desktop/src/preload.ts → apps/desktop/dist/preload.cjs). esbuild only strips
// types and bundles; tsc does all the type-checking (npm run typecheck). Main stays plain .ts.
//
//   npm run ui:build            once
//   npm run ui:build -- --watch rebuild on change (reload the window with Ctrl+R)

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, context } from 'esbuild';
import type { BuildOptions } from 'esbuild';

const ROOT: string = resolve(import.meta.dirname, '..', '..');
const UI_SRC: string = join(ROOT, 'apps', 'ui', 'src');
const UI_DIST: string = join(ROOT, 'apps', 'ui', 'dist');
const DESKTOP_DIST: string = join(ROOT, 'apps', 'desktop', 'dist');

const watch: boolean = process.argv.includes('--watch');

const common: BuildOptions = {
    bundle: true,
    sourcemap: 'linked',
    logLevel: 'info',
    legalComments: 'none',
    // TS sources import each other with .ts / .tsx extensions (allowImportingTsExtensions); esbuild resolves them.
    resolveExtensions: ['.tsx', '.ts', '.js'],
};

const renderer: BuildOptions = {
    ...common,
    entryPoints: { app: join(UI_SRC, 'main.tsx') },
    outdir: UI_DIST,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    minify: !watch,
};

const preload: BuildOptions = {
    ...common,
    entryPoints: [join(ROOT, 'apps', 'desktop', 'src', 'preload.ts')],
    outfile: join(DESKTOP_DIST, 'preload.cjs'),
    format: 'cjs',
    platform: 'node',
    target: 'es2024',
    external: ['electron'],
};

rmSync(UI_DIST, { recursive: true, force: true });
mkdirSync(UI_DIST, { recursive: true });
mkdirSync(DESKTOP_DIST, { recursive: true });
copyFileSync(join(UI_SRC, 'index.html'), join(UI_DIST, 'index.html'));
copyFileSync(join(ROOT, 'assets', 'icon', 'icon.svg'), join(UI_DIST, 'icon.svg'));

if (watch) {
    const contexts = await Promise.all([context(renderer), context(preload)]);
    await Promise.all(contexts.map((c) => c.watch()));
    process.stdout.write('watching apps/ui/src and the preload (index.html is copied once; restart to pick up changes to it)\n');
} else {
    await Promise.all([build(renderer), build(preload)]);
}
