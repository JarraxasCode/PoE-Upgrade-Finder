import type { EngineWarning } from './protocol.ts';

/**
 * Client-side failure codes. Errors the engine itself reports keep the engine's code (load-failed,
 * stale-build, bad-target, ...; engine/README.md).
 */
export type ClientErrorCode = 'startup-failed' | 'timeout' | 'worker-exited' | 'protocol' | 'no-build' | 'shut-down';

export class EngineError extends Error {
    public override readonly name: string = 'EngineError';
    public readonly code: string;
    public readonly warnings: readonly EngineWarning[];

    public constructor(code: ClientErrorCode | string, message: string, warnings: readonly EngineWarning[] = []) {
        super(message);
        this.code = code;
        this.warnings = warnings;
    }

    /** True when the worker is gone or can't be trusted any more, so the next command needs a new one. */
    public get workerLost(): boolean {
        return this.code === 'timeout' || this.code === 'worker-exited' || this.code === 'protocol';
    }
}
