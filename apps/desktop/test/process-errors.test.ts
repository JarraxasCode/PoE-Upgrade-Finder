import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Logger } from '@poe-upgrade-finder/logging';
import { installProcessErrorHandlers } from '../src/process-errors.ts';

interface Line {
    readonly level: string;
    readonly msg: string;
    readonly data: Readonly<Record<string, unknown>> | undefined;
}

test('main-process errors outside IPC and runs are logged; an uncaught exception then exits (issue #63)', () => {
    const lines: Line[] = [];
    const log: Logger = {
        log(level: string, msg: string, data?: Readonly<Record<string, unknown>>): void {
            lines.push({ level: level, msg: msg, data: data });
        },
    };
    const fatal: Error[] = [];
    const proc: EventEmitter = new EventEmitter();
    installProcessErrorHandlers(proc, {
        log: log,
        onFatal: (error: Error) => {
            fatal.push(error);
        },
    });

    proc.emit('unhandledRejection', new Error('a timer promise failed'));
    proc.emit('unhandledRejection', 'a bare string');
    assert.equal(fatal.length, 0, 'a rejection keeps the app running');

    const boom: Error = new Error('thrown in a callback');
    proc.emit('uncaughtException', boom, 'uncaughtException');
    assert.deepEqual(fatal, [boom]);

    assert.deepEqual(
        lines.map((l) => [l.level, l.msg, l.data?.['error']]),
        [
            ['error', 'unhandled promise rejection in the main process', 'a timer promise failed'],
            ['error', 'unhandled promise rejection in the main process', 'a bare string'],
            ['error', 'uncaught exception in the main process', 'thrown in a callback'],
        ],
    );
    assert.match(String(lines[2]?.data?.['stack']), /thrown in a callback\n\s+at /);
    assert.equal(lines[2]?.data?.['origin'], 'uncaughtException');
});
