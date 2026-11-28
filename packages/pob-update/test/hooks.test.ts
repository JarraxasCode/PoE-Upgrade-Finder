// The PoB hook check (src/hooks.ts, #66) without a PoB copy: the messages, and that every PoB method, data
// table, data file and global field engine/lua uses has a hook. test/golden/pob-hooks.test.ts runs the list on
// the pinned copy.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { missingHooks, POB_HOOKS } from '../src/index.ts';
import type { PobHook } from '../src/index.ts';

const ENGINE_LUA: string = fileURLToPath(new URL('../../../engine/lua/', import.meta.url));

/** engine/lua's PoB-facing sources (json.lua is the engine's own), comments stripped. */
function engineSources(): ReadonlyMap<string, string> {
    const out: Map<string, string> = new Map<string, string>();
    for (const name of readdirSync(ENGINE_LUA)) {
        if (name.endsWith('.lua') && name !== 'json.lua') {
            const text: string = readFileSync(join(ENGINE_LUA, name), 'utf8');
            out.set(
                name,
                text
                    .split('\n')
                    .map((line: string) => line.replace(/--.*$/, ''))
                    .join('\n'),
            );
        }
    }
    return out;
}

/** Every distinct first capture of `pattern` in the sources, with a file that uses it. */
function uses(sources: ReadonlyMap<string, string>, pattern: RegExp): ReadonlyMap<string, string> {
    const found: Map<string, string> = new Map<string, string>();
    for (const [file, text] of sources) {
        for (const m of text.matchAll(pattern)) {
            const name: string | undefined = m[1];
            if (name !== undefined && !found.has(name)) {
                found.set(name, file);
            }
        }
    }
    return found;
}

function hooked(match: (hook: PobHook) => boolean): boolean {
    return POB_HOOKS.some(match);
}

describe('PoB hooks', () => {
    test('all present: no messages; a needle gone: its file, needle and engine user; a missing file: once', () => {
        const all: Map<string, string> = new Map<string, string>();
        for (const hook of POB_HOOKS) {
            all.set(hook.file, `${all.get(hook.file) ?? ''}\n${hook.needle}`);
        }
        assert.deepEqual(
            missingHooks((file: string) => all.get(file)),
            [],
        );

        const addItem: PobHook | undefined = POB_HOOKS.find((h: PobHook) => h.needle === 'function ItemsTabClass:AddItem(');
        assert.ok(addItem);
        const without: string = (all.get(addItem.file) ?? '').replace(addItem.needle, 'function ItemsTabClass:AddNewItem(');
        assert.deepEqual(
            missingHooks((file: string) => (file === addItem.file ? without : all.get(file))),
            ['src/Classes/ItemsTab.lua no longer has function ItemsTabClass:AddItem( (used by engine/lua: buildedit)'],
        );

        const data: readonly string[] = missingHooks((file: string) => (file === 'src/Modules/Data.lua' ? undefined : all.get(file)));
        assert.deepEqual(data, ['src/Modules/Data.lua is missing']);
    });

    test('every needle is unique, and every hook names its engine user', () => {
        const keys: Set<string> = new Set<string>();
        for (const hook of POB_HOOKS) {
            const key: string = `${hook.file}|${hook.needle}`;
            assert.ok(!keys.has(key), `${key} twice`);
            keys.add(key);
            assert.ok(hook.needle.trim() !== '' && hook.usedIn !== '', key);
        }
    });

    test('every PoB method engine/lua calls has a hook', () => {
        // Method calls on PoB objects: obj:Name( (Lua's own string methods are lower-case).
        const methods: ReadonlyMap<string, string> = uses(engineSources(), /:([A-Z][A-Za-z]+)\(/g);
        assert.ok(methods.size >= 15, `found only ${methods.size}`);
        for (const [name, file] of methods) {
            assert.ok(
                hooked((h: PobHook) => h.needle.includes(`:${name}(`)),
                `${file} calls :${name}( and no hook checks it`,
            );
        }
    });

    test('every PoB data table engine/lua reads has a hook in Modules/Data.lua', () => {
        // `data` is also the dispatcher's local name for a handler's result (data.code, data.message).
        const local: ReadonlySet<string> = new Set<string>(['code', 'message']);
        const tables: ReadonlyMap<string, string> = uses(engineSources(), /\bdata\.(?:itemMods\.)?([A-Za-z_]+)/g);
        assert.ok(tables.has('essences') && tables.has('ItemExclusive'));
        for (const [name, file] of tables) {
            if (local.has(name)) {
                continue;
            }
            assert.ok(
                hooked((h: PobHook) => h.file === 'src/Modules/Data.lua' && h.needle.includes(name)),
                `${file} reads data.${name} and no hook checks it`,
            );
        }
    });

    test('every PoB global field engine/lua reads (build, launch, main, itemLib) has a hook', () => {
        const fields: ReadonlyMap<string, string> = uses(engineSources(), /\b((?:build|launch|main|itemLib)\.[A-Za-z_]+)/g);
        assert.ok(fields.has('launch.promptMsg') && fields.has('build.itemsTab'));
        for (const [path, file] of fields) {
            const field: string = path.slice(path.indexOf('.') + 1);
            assert.ok(
                hooked((h: PobHook) => new RegExp(`\\b${field}\\b`).test(h.needle)),
                `${file} reads ${path} and no hook checks it`,
            );
        }
    });

    test('every PoB file engine/lua requires has a hook', () => {
        const modules: ReadonlyMap<string, string> = uses(engineSources(), /\brequire\("([^"]+)"\)/g);
        assert.ok(modules.has('Data.TradeSiteStats'));
        for (const [name, file] of modules) {
            // PoB's own modules (Data., Classes.) are under src/; anything else is a runtime library.
            const path: string = /^(?:Data|Classes)./.test(name) ? `src/${name.replace('.', '/')}.lua` : `runtime/lua/${name}.lua`;
            assert.ok(
                hooked((h: PobHook) => h.file === path),
                `${file} requires ${name} and no hook checks ${path}`,
            );
        }
    });
});

test('every hook names engine/lua files that exist', () => {
    const files: ReadonlySet<string> = new Set<string>(readdirSync(ENGINE_LUA));
    for (const hook of POB_HOOKS) {
        for (const name of hook.usedIn.split(', ')) {
            assert.ok(files.has(`${name}.lua`), `${hook.needle}: no engine/lua/${name}.lua`);
        }
    }
});
