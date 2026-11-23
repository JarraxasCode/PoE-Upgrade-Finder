// Dev tool: builds a PoB release copy for the app to ship (PLAN.md, "The pob-update design").
//
//   node tools/pob-update/main.ts --latest
//       prints master's manifest version (the latest release)
//   node tools/pob-update/main.ts --tag v2.68.1 --from <live PoB copy> [--out engine/pob] [--write-pin]
//       stages <out>/<version>.staging from the live copy plus the changed files (by commit sha from raw
//       GitHub), verifies every file, checks the engine's hooks, then renames it to <out>/<version>.
//       --write-pin writes engine/pob-pin.json. Run the golden tests on it next:
//       POE_UF_POB_DIR=<out>/<version> npm test
//       The staged copy's Data/QueryMods.lua is rebuilt with PoB's own code (offline, about 20 s).
//   node tools/pob-update/main.ts --rebuild-querymods <PoB copy>
//       rebuilds just that file in an existing copy
//
// Downloads from PoB Community's GitHub, so check the version before running it.

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type QueryModsReport, rebuildQueryMods, resolveEnginePaths } from '@poe-upgrade-finder/engine-client';
import {
    checkHooks,
    GitHubSource,
    parseManifest,
    type PobManifest,
    type StageEvent,
    type StageReport,
    stageUpdate,
    verifyCopy,
} from '@poe-upgrade-finder/pob-update';
import { describeError } from '@poe-upgrade-finder/validate';

const ROOT: string = resolve(import.meta.dirname, '..', '..');

async function appVersion(): Promise<string> {
    const pkg: unknown = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
        return pkg.version;
    }
    return '0.0.0';
}

function mb(bytes: number): string {
    return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function main(): Promise<number> {
    const { values } = parseArgs({
        options: {
            latest: { type: 'boolean' },
            tag: { type: 'string' },
            from: { type: 'string' },
            out: { type: 'string' },
            'write-pin': { type: 'boolean' },
            'rebuild-querymods': { type: 'string' },
        },
    });
    if (values['rebuild-querymods'] !== undefined) {
        const report: QueryModsReport = await rebuildQueryMods(resolveEnginePaths(resolve(values['rebuild-querymods'])));
        console.log(
            `QueryMods.lua rebuilt in ${report.seconds.toFixed(1)} s: ${JSON.stringify(report.entries)}, ${report.unmatched} unmatched lines`,
        );
        return 0;
    }
    const source: GitHubSource = new GitHubSource({ userAgent: `poe-upgrade-finder/${await appVersion()}` });

    if (values.latest === true) {
        console.log(await source.latestVersion());
        return 0;
    }
    if (values.tag === undefined || values.from === undefined) {
        console.error(
            'usage: --latest | --tag vX.Y.Z --from <live PoB copy> [--out engine/pob] [--write-pin] | --rebuild-querymods <PoB copy>',
        );
        return 2;
    }
    const outDir: string = resolve(values.out ?? join(ROOT, 'engine', 'pob'));
    const started: number = Date.now();
    const latest: string = await source.latestVersion();
    const commit: string = await source.resolveTag(values.tag);
    console.log(`${values.tag} = ${commit}; master's manifest says ${latest}`);
    const version: string = values.tag.slice(1);
    const stagingDir: string = join(outDir, `${version}.staging`);
    const finalDir: string = join(outDir, version);

    const report: StageReport = await stageUpdate({
        liveDir: resolve(values.from),
        stagingDir: stagingDir,
        commit: commit,
        source: source,
        onEvent: (event: StageEvent): void => {
            if (event.kind === 'manifest') {
                console.log(`manifest ${event.version}: ${event.files} files, ${event.skipped} images skipped`);
            } else if (event.kind === 'kept') {
                console.log(`${event.count} files unchanged, copied from the live copy`);
            } else {
                console.log(`  [${event.index}/${event.total}] ${event.path} (${event.bytes} B)`);
            }
        },
    });
    if (report.version !== version) {
        console.error(`the tag's manifest says ${report.version}, not ${version}`);
        return 1;
    }

    const manifest: PobManifest = parseManifest(await readFile(join(stagingDir, 'manifest.xml'), 'utf8'));
    const bad: readonly string[] = await verifyCopy(stagingDir, manifest);
    const hooks: readonly string[] = await checkHooks(stagingDir);
    if (bad.length > 0 || hooks.length > 0) {
        console.error(`verify failed: ${bad.length} files; hooks: ${hooks.join('; ') || 'ok'}`);
        for (const path of bad.slice(0, 20)) {
            console.error(`  ${path}`);
        }
        return 1;
    }

    const queryMods: QueryModsReport = await rebuildQueryMods(resolveEnginePaths(stagingDir));
    console.log(`QueryMods.lua rebuilt in ${queryMods.seconds.toFixed(1)} s: ${JSON.stringify(queryMods.entries)}`);

    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
    const summary: Record<string, unknown> = {
        ...report,
        tag: values.tag,
        masterVersion: latest,
        ms: Date.now() - started,
        fetchedCount: report.fetched.length,
        queryMods: queryMods,
    };
    await writeFile(join(outDir, `${version}.update.json`), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
        `done: ${finalDir}\n  ${report.kept} kept, ${report.fetched.length} fetched, ${mb(report.fetchedBytes)} raw, ` +
            `${mb(report.wireBytes)} on the wire, ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    for (const h of report.headless) {
        console.log(`  ${h.path} sha1 ${h.sha1}`);
    }
    if (values['write-pin'] === true) {
        const pin: string = `${JSON.stringify({ version: version, tag: values.tag, commit: commit }, null, 2)}\n`;
        await writeFile(join(ROOT, 'engine', 'pob-pin.json'), pin);
        console.log('wrote engine/pob-pin.json');
    }
    return 0;
}

main().then(
    (code: number) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        console.error(describeError(error));
        process.exitCode = 1;
    },
);
