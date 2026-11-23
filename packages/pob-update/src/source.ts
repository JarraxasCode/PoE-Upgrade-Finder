// Where PoB's files come from: PoB Community's GitHub. Every file is fetched by commit sha from raw GitHub,
// never by branch, so a moved tag or a push mid-download can't mix versions. The tag is resolved to a sha
// once, through GitHub's API. Injected so the staging code is tested on local files.
//
// Not a trade call, so it doesn't use the trade limiter: one request at a time (the caller awaits each),
// with a retry and backoff on network errors, 429 and 5xx. A 404 fails at once.

import { messageOf, record, string, ValidationError } from '@poe-upgrade-finder/validate';

export const POB_REPO: string = 'PathOfBuildingCommunity/PathOfBuilding';

export interface FetchedFile {
    readonly bytes: Uint8Array;
    /** Bytes on the wire when the server compressed the response (Content-Length), else undefined. */
    readonly encodedBytes: number | undefined;
}

export interface PobSource {
    /** The raw bytes of a repo file at a commit. */
    file(commit: string, path: string): Promise<FetchedFile>;
    /** A release tag's commit sha. */
    resolveTag(tag: string): Promise<string>;
    /** The `<Version number>` of master's manifest.xml: the latest release (master moves only on release). */
    latestVersion(): Promise<string>;
}

export interface GitHubSourceOptions {
    /** `poe-upgrade-finder/<version>`. No contact details. */
    readonly userAgent: string;
    readonly timeoutMs?: number;
    readonly attempts?: number;
    readonly signal?: AbortSignal;
    /** Injected for tests; defaults to Node's fetch. */
    readonly fetchImpl?: typeof fetch;
    /** Injected for tests; defaults to setTimeout. */
    readonly sleep?: (ms: number) => Promise<void>;
}

export class FetchError extends Error {
    public override readonly name: string = 'FetchError';
    public readonly status: number | undefined;

    public constructor(message: string, status: number | undefined) {
        super(message);
        this.status = status;
    }
}

function encodePath(path: string): string {
    return path
        .split('/')
        .map((segment: string) => encodeURIComponent(segment))
        .join('/');
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
        setTimeout(resolve, ms);
    });
}

export class GitHubSource implements PobSource {
    private readonly userAgent: string;
    private readonly timeoutMs: number;
    private readonly attempts: number;
    private readonly signal: AbortSignal | undefined;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;

    public constructor(options: GitHubSourceOptions) {
        this.userAgent = options.userAgent;
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.attempts = options.attempts ?? 4;
        this.signal = options.signal;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sleep = options.sleep ?? defaultSleep;
    }

    public async file(commit: string, path: string): Promise<FetchedFile> {
        if (!/^[0-9a-f]{40}$/.test(commit)) {
            throw new ValidationError(`commit: expected a 40-char sha, got ${commit}`);
        }
        const url: string = `https://raw.githubusercontent.com/${POB_REPO}/${commit}/${encodePath(path)}`;
        const response: Response = await this.get(url, '*/*');
        const bytes: Uint8Array = new Uint8Array(await response.arrayBuffer());
        const encoding: string | null = response.headers.get('content-encoding');
        const length: string | null = response.headers.get('content-length');
        const encodedBytes: number | undefined =
            encoding !== null && encoding !== 'identity' && length !== null ? Number.parseInt(length, 10) : undefined;
        return { bytes: bytes, encodedBytes: encodedBytes };
    }

    public async resolveTag(tag: string): Promise<string> {
        if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
            throw new ValidationError(`tag: expected a release tag like v2.68.1, got ${tag}`);
        }
        const ref: unknown = await this.json(`https://api.github.com/repos/${POB_REPO}/git/ref/tags/${tag}`);
        let object: Readonly<Record<string, unknown>> = record(record(ref, 'ref').object, 'ref.object');
        // An annotated tag points at a tag object, which points at the commit.
        if (string(object.type, 'ref.object.type') === 'tag') {
            const tagSha: string = string(object.sha, 'ref.object.sha');
            const tagObject: unknown = await this.json(`https://api.github.com/repos/${POB_REPO}/git/tags/${tagSha}`);
            object = record(record(tagObject, 'tag').object, 'tag.object');
        }
        if (string(object.type, 'object.type') !== 'commit') {
            throw new ValidationError(`tag ${tag} doesn't point at a commit`);
        }
        const sha: string = string(object.sha, 'object.sha');
        if (!/^[0-9a-f]{40}$/.test(sha)) {
            throw new ValidationError(`tag ${tag}: bad sha ${sha}`);
        }
        return sha;
    }

    public async latestVersion(): Promise<string> {
        const response: Response = await this.get(`https://raw.githubusercontent.com/${POB_REPO}/master/manifest.xml`, '*/*');
        const text: string = await response.text();
        const match: RegExpMatchArray | null = /<Version\s+number="([^"]+)"/.exec(text);
        if (match === null || match[1] === undefined) {
            throw new ValidationError("master's manifest.xml has no <Version number>");
        }
        return match[1];
    }

    private async json(url: string): Promise<unknown> {
        const response: Response = await this.get(url, 'application/vnd.github+json');
        return (await response.json()) as unknown;
    }

    private async get(url: string, accept: string): Promise<Response> {
        let lastError: Error = new FetchError(`GET ${url} failed`, undefined);
        for (let attempt: number = 0; attempt < this.attempts; attempt++) {
            if (attempt > 0) {
                await this.sleep(1000 * 2 ** (attempt - 1));
            }
            const timeout: AbortSignal = AbortSignal.timeout(this.timeoutMs);
            const signal: AbortSignal = this.signal === undefined ? timeout : AbortSignal.any([timeout, this.signal]);
            let response: Response;
            try {
                response = await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent, Accept: accept }, signal: signal });
            } catch (error: unknown) {
                if (this.signal?.aborted === true) {
                    throw new FetchError(`GET ${url}: cancelled`, undefined);
                }
                lastError = new FetchError(`GET ${url}: ${messageOf(error)}`, undefined);
                continue;
            }
            if (response.ok) {
                return response;
            }
            lastError = new FetchError(`GET ${url}: HTTP ${response.status}`, response.status);
            if (response.status !== 429 && response.status < 500) {
                throw lastError;
            }
        }
        throw lastError;
    }
}
