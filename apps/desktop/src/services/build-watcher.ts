// Watches the PoB Builds folder (PLAN.md, How it works, step 1: reload when the file changes). Changes are
// debounced, since a save is written in several steps; the callback then re-lists and reloads as needed.

import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { Logger } from '@poe-upgrade-finder/logging';

export const WATCH_DEBOUNCE_MS: number = 500;

export class BuildWatcher {
    private readonly onChange: () => void;
    private readonly log: Logger;
    private watcher: FSWatcher | undefined = undefined;
    private timer: ReturnType<typeof setTimeout> | undefined = undefined;
    private dir: string | undefined = undefined;

    public constructor(onChange: () => void, log: Logger) {
        this.onChange = onChange;
        this.log = log;
    }

    /** Watches this folder (stops watching the previous one). A missing folder is simply not watched. */
    public watch(dir: string | null): void {
        if (dir === this.dir) {
            return;
        }
        this.stop();
        this.dir = dir ?? undefined;
        if (dir === null) {
            return;
        }
        try {
            this.watcher = watch(dir, { recursive: true, persistent: false }, (_event: string, file: string | Buffer | null) => {
                if (file !== null && !String(file).toLowerCase().endsWith('.xml') && String(file).includes('.')) {
                    return; // not a save (sub-folder changes have no extension and still count)
                }
                this.schedule();
            });
            this.watcher.on('error', (error: Error) => {
                this.log.log('warn', 'builds folder watch failed', { dir: dir, error: error.message });
                this.stop();
            });
            this.log.log('info', 'watching the builds folder', { dir: dir });
        } catch (error: unknown) {
            this.log.log('warn', 'builds folder not watched', { dir: dir, error: error instanceof Error ? error.message : String(error) });
        }
    }

    public stop(): void {
        this.watcher?.close();
        this.watcher = undefined;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private schedule(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.onChange();
        }, WATCH_DEBOUNCE_MS);
    }
}
