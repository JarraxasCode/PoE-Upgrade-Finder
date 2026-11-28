// A stand-in for the Lua dispatcher, for the client's unit tests. It speaks the same protocol with canned
// data. Mode (argv[2]): normal | fatal | silent | bad-json. In score, the item text "CRASH" makes it exit,
// "HANG" makes it stop answering, "BAD" makes it fail the item, and "SCORE-THEN-CRASH" scores the item,
// then exits before the batch's final reply.
import { existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isRecord } from '../src/check.ts';
import type { JsonRecord } from '../src/check.ts';

const mode: string = process.argv[2] ?? 'normal';
const failLoadFile: string | undefined = process.env['FAKE_FAIL_LOAD_FILE'];
const buildIdPrefix: string = `b${process.pid}-`;
let loads: number = 0;
let buildId: string | undefined;

function send(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

const block = (damage: number): unknown => ({ damage: damage, values: { TotalEHP: 'Infinity', Life: 5000, CorruptedBloodImmunity: true } });

if (mode === 'fatal') {
    send({ event: 'fatal', error: { code: 'pob-startup', message: 'no PoB here' } });
    process.exit(3);
}
if (mode === 'silent') {
    setInterval(() => undefined, 1000);
} else {
    process.stderr.write('Loading passive tree assets...\n');
    send(mode === 'bad-json' ? 'not an object' : { event: 'ready', data: { pobVersion: 'fake', gcEvery: 100 } });
}

createInterface({ input: process.stdin }).on('line', (line: string) => {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
        return;
    }
    const req: JsonRecord = parsed;
    const id: unknown = req['id'];
    const reply = (data: unknown): void => send({ id: id, ok: true, data: data, warnings: [] });
    const fail = (code: string, message: string): void =>
        send({ id: id, ok: false, error: { code: code, message: message }, warnings: [] });
    const needsBuild = (): boolean => {
        if (req['buildId'] !== buildId) {
            fail('stale-build', `build ${String(req['buildId'])} is not loaded`);
            return false;
        }
        return true;
    };
    switch (req['cmd']) {
        case 'ping':
            reply({ pobVersion: 'fake', gcEvery: 100, scoresSinceGc: 0, gcRuns: 0, luaHeapMb: 1 });
            return;
        case 'loadBuild':
            // FAKE_FAIL_LOAD_FILE: while that file exists, one load fails and removes it (a reload that fails once).
            if (failLoadFile !== undefined && existsSync(failLoadFile)) {
                unlinkSync(failLoadFile);
                buildId = undefined;
                fail('load-failed', 'reload failed once');
                return;
            }
            if (req['xml'] === 'BROKEN') {
                buildId = undefined;
                fail('load-failed', 'trying to close <Build>');
                return;
            }
            buildId = `${buildIdPrefix}${++loads}`;
            send({
                id: id,
                ok: true,
                warnings: [{ code: 'no-damage-target', message: 'reads 0' }],
                data: {
                    buildId: buildId,
                    pobVersion: 'fake',
                    info: { level: 90 },
                    skills: {},
                    target: { kind: 'fullDps', saved: true },
                    baseline: block(100),
                    equipped: [],
                },
            });
            return;
        case 'stats':
            if (needsBuild()) {
                reply({ target: { kind: 'fullDps', saved: true }, stats: block(100) });
            }
            return;
        case 'score': {
            if (!needsBuild()) {
                return;
            }
            const items: unknown[] = Array.isArray(req['items']) ? req['items'] : [];
            for (let i: number = 0; i < items.length; i++) {
                if (items[i] === 'CRASH') {
                    setTimeout(() => process.exit(1), 20);
                    return;
                }
                if (items[i] === 'HANG') {
                    return;
                }
                if (items[i] === 'BAD') {
                    send({
                        id: id,
                        event: 'item',
                        data: { index: i, ok: false, error: { code: 'parse-failed', message: 'no base type' } },
                    });
                    continue;
                }
                send({
                    id: id,
                    event: 'item',
                    data: {
                        index: i,
                        ok: true,
                        item: { name: String(items[i]), base: 'Boots', rarity: 'RARE' },
                        stats: block(100 + i),
                        unparsed: [],
                        validForSlot: true,
                        offHandRemoved: false,
                    },
                });
                if (items[i] === 'SCORE-THEN-CRASH') {
                    setTimeout(() => process.exit(1), 20);
                    return;
                }
            }
            reply({ count: items.length, failed: 0, gcRuns: 0, seconds: 0, offHandRemoved: 0 });
            return;
        }
        case 'shutdown':
            reply({});
            setTimeout(() => process.exit(0), 10);
            return;
        default:
            fail('unknown-command', `unknown command ${String(req['cmd'])}`);
    }
});
