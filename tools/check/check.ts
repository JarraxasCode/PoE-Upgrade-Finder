// `npm run check`: the typecheck, then every test with POE_UF_REQUIRE_POB=1, so a missing PoB copy fails the
// golden tests instead of skipping them (#66; test/golden/engine.ts). A plain `npm test` leaves it unset and
// still skips, for a clone without the copy. An explicit POE_UF_REQUIRE_POB in the environment wins
// (`POE_UF_REQUIRE_POB=0 npm run check` opts out). No shell syntax, so it runs the same on every platform.
//
//   node tools/check/check.ts

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { REQUIRE_POB_ENV } from '@poe-upgrade-finder/engine-client';
import { messageOf } from '@poe-upgrade-finder/validate';

/** Runs an npm script with the environment given; returns its exit code (1 when it couldn't start or was killed). */
function npm(args: readonly string[], env: NodeJS.ProcessEnv): number {
    // Under `npm run`, npm_execpath is npm's own script: run it with this node, no shell needed.
    const npmCli: string | undefined = process.env['npm_execpath'];
    const result: SpawnSyncReturns<Buffer> =
        npmCli !== undefined && npmCli !== ''
            ? spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit', env: env })
            : spawnSync('npm', [...args], { stdio: 'inherit', env: env, shell: process.platform === 'win32' });
    if (result.error !== undefined) {
        process.stderr.write(`check: npm ${args.join(' ')} didn't start: ${messageOf(result.error)}\n`);
        return 1;
    }
    return result.status ?? 1;
}

function main(): number {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env[REQUIRE_POB_ENV] ??= '1';
    const typecheck: number = npm(['run', 'typecheck'], env);
    if (typecheck !== 0) {
        return typecheck;
    }
    return npm(['test'], env);
}

process.exitCode = main();
