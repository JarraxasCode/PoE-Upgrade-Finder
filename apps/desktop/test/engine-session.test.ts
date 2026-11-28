// EngineSession on the engine client's fake engine (packages/engine-client/test/fake-engine.ts).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EngineError } from '@poe-upgrade-finder/engine-client';
import type { Logger } from '@poe-upgrade-finder/logging';
import { EngineSession } from '../src/services/engine-session.ts';
import type { LoadedBuild } from '../src/services/engine-session.ts';

const fake: string = fileURLToPath(new URL('../../../packages/engine-client/test/fake-engine.ts', import.meta.url));
const dir: string = mkdtempSync(join(tmpdir(), 'uf-session-'));
after(() => {
    rmSync(dir, { recursive: true, force: true });
});

const quiet: Logger = {
    log(): void {
        // Tests don't read the session's log.
    },
};

test('the engine losing the build (stale-build, no-build) makes the next ensure load it again (issue #42)', async () => {
    const file: string = join(dir, 'build.xml');
    writeFileSync(file, '<PathOfBuilding/>');
    const session: EngineSession = new EngineSession({
        command: () => ({ command: process.execPath, args: [fake, 'normal'], env: {} }),
        logger: quiet,
        onState: () => undefined,
    });
    try {
        const first: LoadedBuild = await session.ensure('b', file, 'saved');
        assert.equal(await session.ensure('b', file, 'saved'), first, 'unchanged: the loaded build is reused');

        for (const code of ['stale-build', 'no-build']) {
            const before: LoadedBuild | undefined = session.loaded;
            await assert.rejects(
                session.exclusive(() => Promise.reject(new EngineError(code, 'build b1 is not loaded'))),
                (error: unknown) => error instanceof EngineError && error.code === code,
            );
            assert.equal(session.loaded, undefined, `${code}: the loaded build is forgotten`);
            const again: LoadedBuild = await session.ensure('b', file, 'saved');
            assert.notEqual(again, before, `${code}: loaded again`);
            assert.notEqual(again.load.buildId, before?.load.buildId);
        }

        // Other errors leave it loaded.
        const loaded: LoadedBuild | undefined = session.loaded;
        await assert.rejects(session.exclusive(() => Promise.reject(new EngineError('calc-failed', 'x'))));
        assert.equal(session.loaded, loaded);
    } finally {
        await session.shutdown();
    }
});
