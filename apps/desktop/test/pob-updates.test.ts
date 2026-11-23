import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { PobUpdateState } from '@poe-upgrade-finder/ipc';
import type { FetchedFile, PobSource } from '@poe-upgrade-finder/pob-update';
import { manifestVersion, PobUpdates, readCurrent } from '../src/services/pob-updates.ts';

const silent = { log: (): void => {} };
const dirs: string[] = [];
after(() => {
    for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
    }
});

/** A PoB copy's files: the engine's hooks, the licence and one data file whose text marks the version. */
function files(version: string): Record<string, string> {
    return {
        'LICENSE.md': 'MIT\n',
        'src/HeadlessWrapper.lua': 'loadBuildFromXML\n',
        'src/_SimpleGraphic.def.lua': 'stubs\n',
        'src/Classes/CalcsTab.lua': 'GetMiscCalculator\n',
        'src/Classes/ItemsTab.lua': 'repSlotName\n',
        'src/Classes/TradeQueryGenerator.lua': 'StartQuery\n',
        'src/Modules/Data.lua': `powerStatList -- ${version}\n`,
    };
}

function manifest(version: string): string {
    const crlf = (t: string): string => createHash('sha1').update(t.replaceAll('\n', '\r\n')).digest('hex');
    const lines: string[] = [];
    for (const [path, text] of Object.entries(files(version))) {
        if (path === 'src/HeadlessWrapper.lua' || path === 'src/_SimpleGraphic.def.lua') {
            continue;
        }
        const [part, name] = path === 'LICENSE.md' ? ['default', path] : ['program', path.slice(4)];
        lines.push(`<File name="${name}" part="${part}" sha1="${crlf(text)}" />`);
    }
    return `<PoBVersion><Version number="${version}" />\n${lines.join('\n')}\n</PoBVersion>\n`;
}

function writeCopy(dir: string, version: string): void {
    for (const [path, text] of Object.entries({ ...files(version), 'manifest.xml': manifest(version) })) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
}

function fakeSource(latest: string): PobSource & { asked: string[] } {
    const remote: Record<string, string> = { ...files(latest), 'manifest.xml': manifest(latest) };
    const asked: string[] = [];
    return {
        asked: asked,
        file: async (_commit: string, path: string): Promise<FetchedFile> => {
            asked.push(path);
            const text: string | undefined = remote[path];
            if (text === undefined) {
                throw new Error(`404 ${path}`);
            }
            return { bytes: new TextEncoder().encode(text), encodedBytes: undefined };
        },
        resolveTag: async (): Promise<string> => 'c'.repeat(40),
        latestVersion: async (): Promise<string> => latest,
    };
}

function setup(latest: string): {
    updates: PobUpdates;
    bundled: string;
    root: string;
    states: PobUpdateState[];
    source: ReturnType<typeof fakeSource>;
} {
    const base: string = mkdtempSync(join(tmpdir(), 'pob-updates-'));
    dirs.push(base);
    const bundled: string = join(base, 'bundled');
    writeCopy(bundled, '2.68.1');
    const root: string = join(base, 'local', 'pob');
    const states: PobUpdateState[] = [];
    const source = fakeSource(latest);
    const updates: PobUpdates = new PobUpdates({
        root: root,
        bundledDir: bundled,
        fixedDir: undefined,
        source: source,
        logger: silent,
        onState: (s) => states.push(s),
    });
    return { updates: updates, bundled: bundled, root: root, states: states, source: source };
}

test('PobUpdates: the bundled copy is live until an update; a newer copy goes live after its smoke check', async () => {
    const { updates, bundled, root, states, source } = setup('2.69.0');
    assert.equal(updates.liveDir(), bundled);
    assert.equal((await updates.check()).latest, '2.69.0');

    let smokedOn: string | undefined;
    const order: string[] = [];
    let swapped: number = 0;
    const done: PobUpdateState = await updates.update(
        async (dir: string) => {
            smokedOn = dir;
            order.push('smoke');
            return 'ok';
        },
        async () => {
            swapped++;
        },
        async (dir: string) => {
            assert.ok(dir.endsWith('2.69.0.staging'));
            order.push('rebuild');
        },
    );
    assert.deepEqual(order, ['rebuild', 'smoke']);
    assert.equal(done.phase, 'idle', done.message ?? '');
    assert.equal(done.live, '2.69.0');
    assert.equal(done.previous, '2.68.1');
    assert.ok(smokedOn?.endsWith('2.69.0.staging'));
    assert.equal(swapped, 1);
    assert.equal(updates.liveDir(), join(root, '2.69.0'));
    assert.deepEqual(readCurrent(root), { version: '2.69.0', previous: '2.68.1' });
    assert.equal(manifestVersion(join(root, '2.69.0')), '2.69.0');
    assert.ok(!existsSync(join(root, '2.69.0.staging')));
    // Only the changed file and the two headless files were fetched (plus the manifest).
    assert.deepEqual(source.asked.sort(), [
        'manifest.xml',
        'src/HeadlessWrapper.lua',
        'src/Modules/Data.lua',
        'src/_SimpleGraphic.def.lua',
    ]);
    assert.ok(states.some((s) => s.phase === 'updating' && (s.step ?? '').startsWith('Downloading')));

    const back: PobUpdateState = await updates.rollback(async () => {
        swapped++;
    });
    assert.equal(back.live, '2.68.1');
    assert.equal(updates.liveDir(), bundled);
    assert.equal(swapped, 2);
});

test('PobUpdates: a failed smoke check keeps the live copy and removes the staging folder', async () => {
    const { updates, bundled, root } = setup('2.69.0');
    const result: PobUpdateState = await updates.update(
        async () => {
            throw new Error("your own Boots re-listed doesn't score +0");
        },
        async () => {
            assert.fail('no swap on failure');
        },
        async () => {},
    );
    assert.equal(result.phase, 'failed');
    assert.match(result.message ?? '', /2\.68\.1 is still in use.*\+0/);
    assert.equal(updates.liveDir(), bundled);
    assert.equal(readCurrent(root), undefined);
    assert.ok(!existsSync(join(root, '2.69.0.staging')));
});

test('PobUpdates: nothing to do when the live copy is the latest; a newer bundled copy beats an older update', async () => {
    const { updates, bundled, root } = setup('2.68.1');
    const same: PobUpdateState = await updates.update(
        async () => 'ok',
        async () => {},
        async () => {},
    );
    assert.equal(same.phase, 'idle');
    assert.match(same.message ?? '', /is the latest/);

    // An update to 2.68.0 recorded earlier (older than the app's bundled 2.68.1): the bundled copy wins.
    writeCopy(join(root, '2.68.0'), '2.68.0');
    writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '2.68.0', previous: null }));
    assert.equal(updates.liveDir(), bundled);
    assert.equal(readFileSync(join(updates.liveDir() ?? '', 'manifest.xml'), 'utf8').includes('2.68.1'), true);
});
