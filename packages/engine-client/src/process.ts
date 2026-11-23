// One engine worker process: spawns it, waits for its ready event, sends requests one JSON line at a time
// and routes the replies by id. It knows nothing about builds; EngineClient does that.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProtocolError } from './check.ts';
import { EngineError } from './errors.ts';
import type { EngineLogger } from './logger.ts';
import { parseMessage } from './protocol.ts';
import type { CommandName, EngineMessage, FinalMessage, ReadyEvent, StreamEvent } from './protocol.ts';
import { messageOf } from '@poe-upgrade-finder/validate';

/** How to start a worker: luahostCommand() builds this for the real engine; tests pass a fake one. */
export interface EngineCommand {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

interface Pending {
    readonly cmd: CommandName;
    readonly started: number;
    readonly idleMs: number;
    readonly onEvent: (event: StreamEvent) => void;
    readonly resolve: (message: FinalMessage) => void;
    readonly reject: (error: EngineError) => void;
    timer: NodeJS.Timeout | undefined;
}

const STDERR_TAIL_LINES: number = 40;

export class EngineProcess {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly logger: EngineLogger;
    private readonly pending: Map<number, Pending> = new Map<number, Pending>();
    private readonly stderrTail: string[] = [];
    private readonly exitPromise: Promise<number | null>;
    private seq: number = 0;
    private exited: boolean = false;
    private failure: EngineError | undefined = undefined;
    private readyInfo: ReadyEvent | undefined = undefined;
    private onReady: ((ready: ReadyEvent) => void) | undefined = undefined;
    private onStartupFailure: ((error: EngineError) => void) | undefined = undefined;

    private constructor(command: EngineCommand, logger: EngineLogger) {
        this.logger = logger;
        this.child = spawn(command.command, [...command.args], {
            env: { ...process.env, ...command.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.logger.log('info', 'engine worker starting', { pid: this.child.pid, command: command.command });
        this.exitPromise = new Promise<number | null>((resolve: (code: number | null) => void) => {
            // 'close', not 'exit': it fires after stdout has drained, so a last reply (shutdown's) isn't lost.
            this.child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
                this.handleExit(code, signal);
                resolve(code);
            });
        });
        this.child.on('error', (error: Error) => {
            this.fail(new EngineError('startup-failed', `could not start the engine (${command.command}): ${error.message}`));
        });
        this.child.stdin.on('error', (error: Error) => {
            this.logger.log('warn', 'engine stdin error', { message: error.message });
        });
        createInterface({ input: this.child.stdout }).on('line', (line: string) => {
            this.handleLine(line);
        });
        createInterface({ input: this.child.stderr }).on('line', (line: string) => {
            this.stderrTail.push(line);
            if (this.stderrTail.length > STDERR_TAIL_LINES) {
                this.stderrTail.shift();
            }
            this.logger.log(line.startsWith('engine:') ? 'warn' : 'debug', line, { area: 'pob' });
        });
    }

    /** Starts a worker and resolves once it has sent its ready event. */
    public static async start(command: EngineCommand, logger: EngineLogger, startupTimeoutMs: number): Promise<EngineProcess> {
        const worker: EngineProcess = new EngineProcess(command, logger);
        const started: number = Date.now();
        await new Promise<void>((resolve: () => void, reject: (error: EngineError) => void) => {
            const timer: NodeJS.Timeout = setTimeout(() => {
                worker.fail(
                    new EngineError(
                        'startup-failed',
                        `the engine sent no ready event within ${startupTimeoutMs} ms${worker.stderrSummary()}`,
                    ),
                );
            }, startupTimeoutMs);
            worker.onReady = (): void => {
                clearTimeout(timer);
                resolve();
            };
            worker.onStartupFailure = (error: EngineError): void => {
                clearTimeout(timer);
                worker.kill('startup failed');
                reject(error);
            };
        });
        logger.log('info', 'engine worker ready', { pid: worker.child.pid, ms: Date.now() - started, pobVersion: worker.ready.pobVersion });
        return worker;
    }

    public get ready(): ReadyEvent {
        if (!this.readyInfo) {
            throw new EngineError('startup-failed', 'the engine is not ready');
        }
        return this.readyInfo;
    }

    public get alive(): boolean {
        return !this.exited && this.failure === undefined;
    }

    public get pid(): number | undefined {
        return this.child.pid;
    }

    /**
     * Sends one request. The idle timer restarts on every stream event, so a long tradeQuery or score batch
     * only times out when the engine goes quiet. A timeout kills the worker: a hung PoB can't be trusted.
     */
    public request(
        cmd: CommandName,
        args: Readonly<Record<string, unknown>>,
        idleMs: number,
        onEvent: (event: StreamEvent) => void,
    ): Promise<FinalMessage> {
        if (this.failure) {
            return Promise.reject(this.failure);
        }
        if (this.exited) {
            return Promise.reject(new EngineError('worker-exited', 'the engine has exited'));
        }
        const id: number = ++this.seq;
        return new Promise<FinalMessage>((resolve: (message: FinalMessage) => void, reject: (error: EngineError) => void) => {
            const entry: Pending = {
                cmd: cmd,
                started: Date.now(),
                idleMs: idleMs,
                onEvent: onEvent,
                resolve: resolve,
                reject: reject,
                timer: undefined,
            };
            this.pending.set(id, entry);
            this.armTimer(id, entry);
            this.child.stdin.write(`${JSON.stringify({ ...args, id: id, cmd: cmd })}\n`);
        });
    }

    /** Kills the worker. Requests still waiting fail with worker-exited. */
    public kill(reason: string): void {
        if (!this.exited) {
            this.logger.log('warn', 'killing engine worker', { pid: this.child.pid, reason: reason });
            this.child.kill();
        }
    }

    /** Resolves with the exit code once the worker has exited, or kills it after timeoutMs. */
    public async waitForExit(timeoutMs: number): Promise<number | null> {
        const timer: NodeJS.Timeout = setTimeout(() => {
            this.kill('did not exit after shutdown');
        }, timeoutMs);
        try {
            return await this.exitPromise;
        } finally {
            clearTimeout(timer);
        }
    }

    private armTimer(id: number, entry: Pending): void {
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        entry.timer = setTimeout(() => {
            this.fail(
                new EngineError(
                    'timeout',
                    `engine ${entry.cmd} went ${entry.idleMs} ms without a reply (request ${id})${this.stderrSummary()}`,
                ),
            );
            this.kill(`${entry.cmd} timed out`);
        }, entry.idleMs);
    }

    private handleLine(line: string): void {
        let message: EngineMessage;
        try {
            message = parseMessage(line);
        } catch (error: unknown) {
            const text: string = error instanceof ProtocolError ? error.message : String(error);
            this.logger.log('error', 'bad message from engine', { error: text, line: line.slice(0, 500) });
            this.fail(new EngineError('protocol', `bad message from the engine: ${text}`));
            this.kill('protocol error');
            return;
        }
        switch (message.type) {
            case 'ready':
                this.readyInfo = message;
                this.onReady?.(message);
                return;
            case 'fatal':
                this.fail(new EngineError('startup-failed', `PoB failed to start: ${message.error.message}`));
                return;
            case 'stream': {
                const entry: Pending | undefined = this.pending.get(message.id);
                if (!entry) {
                    this.logger.log('warn', 'engine event for an unknown request', { id: message.id, event: message.event });
                    return;
                }
                this.armTimer(message.id, entry);
                try {
                    entry.onEvent(message);
                } catch (error: unknown) {
                    // A bad event (or a throwing callback) ends this worker: the stream can't be trusted.
                    const text: string = messageOf(error);
                    this.fail(new EngineError('protocol', `bad ${message.event} event from the engine: ${text}`));
                    this.kill('bad stream event');
                }
                return;
            }
            case 'final': {
                const entry: Pending | undefined = this.pending.get(message.id);
                if (!entry) {
                    this.logger.log('warn', 'engine reply for an unknown request', { id: message.id });
                    return;
                }
                this.pending.delete(message.id);
                if (entry.timer) {
                    clearTimeout(entry.timer);
                }
                this.logger.log(message.ok ? 'debug' : 'warn', `engine ${entry.cmd} ${message.ok ? 'done' : 'failed'}`, {
                    id: message.id,
                    ms: Date.now() - entry.started,
                    error: message.error,
                    warnings: message.warnings.length > 0 ? message.warnings : undefined,
                });
                entry.resolve(message);
                return;
            }
        }
    }

    private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
        this.exited = true;
        this.logger.log(this.pending.size > 0 || !this.readyInfo ? 'warn' : 'info', 'engine worker exited', {
            pid: this.child.pid,
            code: code,
            signal: signal,
        });
        this.fail(new EngineError('worker-exited', `the engine exited (code ${code ?? signal ?? '?'})${this.stderrSummary()}`));
    }

    /** Records the first failure and fails everything waiting on this worker with it. */
    private fail(error: EngineError): void {
        if (!this.failure) {
            this.failure = error;
        }
        if (!this.readyInfo) {
            this.onStartupFailure?.(this.failure);
        }
        for (const [id, entry] of this.pending) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
            this.pending.delete(id);
            entry.reject(this.failure);
        }
    }

    private stderrSummary(): string {
        const tail: string[] = this.stderrTail.slice(-5);
        return tail.length > 0 ? `; last engine output: ${tail.join(' | ')}` : '';
    }
}
