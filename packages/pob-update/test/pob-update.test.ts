import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
    compareVersions,
    type FetchedFile,
    GitHubSource,
    isSkipped,
    parseManifest,
    parsePin,
    type PobSource,
    pobSha1,
    stageUpdate,
    verifyCopy,
} from '@poe-upgrade-finder/pob-update';

function sha1(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

describe('pobSha1', () => {
    it('normalises LF, CR and CRLF to CRLF in text files', () => {
        const crlf: string = sha1('a\r\nb\r\nc\r\n');
        assert.equal(pobSha1(new TextEncoder().encode('a\nb\nc\n')), crlf);
        assert.equal(pobSha1(new TextEncoder().encode('a\r\nb\rc\n')), crlf);
    });
    it('hashes binary files (with a NUL) as they are', () => {
        const bytes: Uint8Array = new Uint8Array([0, 10, 13, 65]);
        assert.equal(pobSha1(bytes), createHash('sha1').update(bytes).digest('hex'));
    });
});

describe('parseManifest', () => {
    it('reads the version and files, keeping {space} literal and mapping parts to repo paths', () => {
        const m = parseManifest(`<?xml version='1.0'?>
<PoBVersion>
	<Version number="2.68.1" />
	<Source part="default" url="x" />
	<File name="LICENSE.md" part="default" sha1="${'a'.repeat(40)}" />
	<File name="Path{space}of{space}Building.exe" part="runtime" runtime="win32" sha1="${'B'.repeat(40)}" />
	<File name="Modules/Data.lua" part="program" sha1="${'c'.repeat(40)}" />
</PoBVersion>`);
        assert.equal(m.version, '2.68.1');
        assert.deepEqual(
            m.files.map((f) => f.path),
            ['LICENSE.md', 'runtime/Path{space}of{space}Building.exe', 'src/Modules/Data.lua'],
        );
        assert.equal(m.files[1]?.sha1, 'b'.repeat(40));
    });
    it('refuses unsafe names and bad hashes', () => {
        const wrap = (file: string): string => `<PoBVersion><Version number="1.0.0" />${file}</PoBVersion>`;
        assert.throws(() => parseManifest(wrap(`<File name="../x" part="program" sha1="${'a'.repeat(40)}" />`)), /unsafe/);
        assert.throws(() => parseManifest(wrap('<File name="x" part="program" sha1="abc" />')), /sha1/);
        assert.throws(() => parseManifest(wrap(`<File name="x" part="nope" sha1="${'a'.repeat(40)}" />`)), /part/);
    });
});

describe('isSkipped and versions and pins', () => {
    it('skips tree images and Assets only', () => {
        assert.equal(isSkipped('src/TreeData/3_30/skills-3.jpg'), true);
        assert.equal(isSkipped('src/Assets/x.png'), true);
        assert.equal(isSkipped('src/TreeData/3_30/tree.lua'), false);
        assert.equal(isSkipped('runtime/fonts/a.png'), false);
    });
    it('compares versions numerically', () => {
        assert.equal(compareVersions('2.68.1', '2.9.0'), 1);
        assert.equal(compareVersions('2.68.1', '2.68.1'), 0);
        assert.equal(compareVersions('2.67.2', '2.68.0'), -1);
    });
    it('checks the pin', () => {
        assert.deepEqual(parsePin({ version: '2.68.1', tag: 'v2.68.1', commit: 'a'.repeat(40) }).tag, 'v2.68.1');
        assert.throws(() => parsePin({ version: '2.68.1', tag: 'v2.68.0', commit: 'a'.repeat(40) }));
    });
});

describe('stageUpdate', () => {
    const dirs: string[] = [];
    after(async () => {
        for (const d of dirs) {
            await rm(d, { recursive: true, force: true });
        }
    });

    it('keeps unchanged files, fetches changed and missing ones, drops dropped ones and skips images', async () => {
        const root: string = await mkdtemp(join(tmpdir(), 'pob-update-'));
        dirs.push(root);
        const live: string = join(root, 'live');
        const put = async (path: string, text: string): Promise<void> => {
            await mkdir(dirname(join(live, path)), { recursive: true });
            await writeFile(join(live, path), text);
        };
        await put('LICENSE.md', 'MIT\n');
        await put('src/Modules/Data.lua', 'old\n');
        await put('src/Dropped.lua', 'gone\n');
        await put('src/TreeData/3_30/skills.png', 'img');

        const remote: Record<string, string> = {
            'LICENSE.md': 'MIT\n',
            'src/Modules/Data.lua': 'new\n',
            'src/Added.lua': 'added\n',
            'src/HeadlessWrapper.lua': 'loadBuildFromXML\n',
            'src/_SimpleGraphic.def.lua': 'stubs\n',
        };
        const crlf = (t: string): string => sha1(t.replaceAll('\n', '\r\n'));
        remote['manifest.xml'] = `<PoBVersion><Version number="2.68.1" />
<File name="LICENSE.md" part="default" sha1="${crlf('MIT\n')}" />
<File name="Modules/Data.lua" part="program" sha1="${crlf('new\n')}" />
<File name="Added.lua" part="program" sha1="${crlf('added\n')}" />
<File name="TreeData/3_30/skills.png" part="tree" sha1="${'0'.repeat(40)}" />
</PoBVersion>`;
        const asked: string[] = [];
        const source: PobSource = {
            file: async (_commit: string, path: string): Promise<FetchedFile> => {
                asked.push(path);
                const text: string | undefined = remote[path];
                if (text === undefined) {
                    throw new Error(`404 ${path}`);
                }
                return { bytes: new TextEncoder().encode(text), encodedBytes: undefined };
            },
            resolveTag: async (): Promise<string> => 'a'.repeat(40),
            latestVersion: async (): Promise<string> => '2.68.1',
        };
        const staging: string = join(root, '2.68.1.staging');
        const report = await stageUpdate({ liveDir: live, stagingDir: staging, commit: 'a'.repeat(40), source: source });

        assert.equal(report.kept, 1);
        assert.deepEqual(
            report.fetched.map((f) => `${f.path}:${f.reason}`),
            ['src/Modules/Data.lua:changed', 'src/Added.lua:missing'],
        );
        assert.equal(report.skipped, 1);
        assert.ok(!asked.includes('src/TreeData/3_30/skills.png'));
        assert.equal(await readFile(join(staging, 'src/Modules/Data.lua'), 'utf8'), 'new\n');
        await assert.rejects(readFile(join(staging, 'src/Dropped.lua')));
        await assert.rejects(readFile(join(staging, 'src/TreeData/3_30/skills.png')));
        assert.deepEqual(await verifyCopy(staging, parseManifest(remote['manifest.xml'])), []);
    });

    it('refuses a fetched file whose sha1 does not match', async () => {
        const root: string = await mkdtemp(join(tmpdir(), 'pob-update-'));
        dirs.push(root);
        const source: PobSource = {
            file: async (_c: string, path: string): Promise<FetchedFile> => ({
                bytes: new TextEncoder().encode(
                    path === 'manifest.xml'
                        ? `<PoBVersion><Version number="1.0.0" /><File name="LICENSE.md" part="default" sha1="${'f'.repeat(40)}" /></PoBVersion>`
                        : 'tampered',
                ),
                encodedBytes: undefined,
            }),
            resolveTag: async (): Promise<string> => '',
            latestVersion: async (): Promise<string> => '',
        };
        await assert.rejects(
            stageUpdate({ liveDir: join(root, 'none'), stagingDir: join(root, 'x.staging'), commit: 'a'.repeat(40), source: source }),
            /doesn't match/,
        );
    });
});

describe('GitHubSource', () => {
    it('fetches by commit sha with our User-Agent, retries a 503 and fails a 404 at once', async () => {
        const calls: { url: string; ua: string | null }[] = [];
        let n: number = 0;
        const fake = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            calls.push({ url: String(url), ua: new Headers(init?.headers).get('user-agent') });
            n++;
            if (String(url).includes('missing')) {
                return new Response('', { status: 404 });
            }
            return n === 1 ? new Response('', { status: 503 }) : new Response('hello');
        }) as typeof fetch;
        const source: GitHubSource = new GitHubSource({ userAgent: 'poe-upgrade-finder/0.1.0', fetchImpl: fake, sleep: async () => {} });
        const sha: string = 'a'.repeat(40);
        const got: FetchedFile = await source.file(sha, 'runtime/Path{space}of{space}Building.exe');
        assert.equal(new TextDecoder().decode(got.bytes), 'hello');
        assert.equal(calls.length, 2);
        assert.equal(
            calls[0]?.url,
            `https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/${sha}/runtime/Path%7Bspace%7Dof%7Bspace%7DBuilding.exe`,
        );
        assert.equal(calls[0]?.ua, 'poe-upgrade-finder/0.1.0');
        await assert.rejects(source.file(sha, 'missing'), /404/);
        assert.equal(calls.length, 3);
        await assert.rejects(source.file('master', 'x'), /sha/);
    });
});
