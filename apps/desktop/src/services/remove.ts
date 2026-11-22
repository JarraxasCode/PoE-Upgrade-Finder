// "Remove from this PC" (PLAN.md, Phase 5) and the PoB facts for About.
//
// Removal is done by the launcher exe (tools/launcher), which isn't running from the folders it deletes. The
// app only asks: it writes Local\remove-requested and exits with REMOVE_EXIT_CODE. The launcher needs both,
// so a stray exit code never deletes anything. Without the launcher (dev), removal isn't offered.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Must match RemoveExitCode in tools/launcher/Launcher.cs. */
export const REMOVE_EXIT_CODE: number = 86;
/** Must match RemoveMarker in tools/launcher/Launcher.cs. */
export const REMOVE_MARKER: string = 'remove-requested';
const APP_FOLDER: string = 'poe-upgrade-finder';

/** The launcher sets POE_UF_LAUNCHER to its own path when it starts the app. */
export function launchedByLauncher(env: NodeJS.ProcessEnv = process.env): boolean {
    const path: string | undefined = env['POE_UF_LAUNCHER'];
    return path !== undefined && path !== '' && existsSync(path);
}

/** %LOCALAPPDATA%\poe-upgrade-finder: the unpacked app (and the launcher's log). */
export function localAppFolder(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const local: string | undefined = env['LOCALAPPDATA'];
    return local === undefined || local === '' ? undefined : join(local, APP_FOLDER);
}

export function writeRemoveMarker(localFolder: string): void {
    mkdirSync(localFolder, { recursive: true });
    writeFileSync(join(localFolder, REMOVE_MARKER), `${new Date().toISOString()}\n`);
}

/** The `<Version number>` of a PoB copy's manifest.xml, or null. */
export function pobVersionOf(pobDir: string | undefined): string | null {
    if (pobDir === undefined) {
        return null;
    }
    try {
        const match: RegExpExecArray | null = /<Version\s+number="([^"]+)"/.exec(readFileSync(join(pobDir, 'manifest.xml'), 'utf8'));
        return match?.[1] ?? null;
    } catch {
        return null;
    }
}

/** PoB's LICENSE.md as shipped, or null. */
export function pobLicenseOf(pobDir: string | undefined): string | null {
    if (pobDir === undefined) {
        return null;
    }
    try {
        return readFileSync(join(pobDir, 'LICENSE.md'), 'utf8');
    } catch {
        return null;
    }
}
