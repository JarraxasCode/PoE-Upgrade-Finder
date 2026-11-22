// The Electron main process. Two modes:
//   (no mode word)  the windowed app (ui/ui-app.ts): npm run app
//   search          the headless mode (headless.ts): no main window, one signed-in search for one slot
//
// Run from the repo root:  npm run app   |   npm run search -- --build <save.xml> --slot Boots --budget 300c

import { app } from 'electron';
import { runHeadless } from './headless.ts';
import { runUiApp } from './ui/ui-app.ts';

// In dev (`electron apps/desktop …`) argv[1] is the app folder; the packaged exe has none (process.defaultApp
// is set only when Electron runs an app given on the command line).
const argv: readonly string[] = process.argv.slice(process.defaultApp === true ? 2 : 1);
// A plain word, not a switch: Chromium takes --headless as its own (no windows at all, sign-in included).
// It must come first: anywhere else it can be an option's value (e.g. --route search).
const headless: boolean = argv[0] === 'search';

function report(error: unknown): void {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}

if (headless) {
    // The sign-in window is the only window; closing it must not end the run.
    app.on('window-all-closed', () => {
        // stay running until the run ends
    });
}

void app.whenReady().then(async () => {
    if (headless) {
        let code: number;
        try {
            code = await runHeadless(argv, app.getPath('userData'), app.getVersion());
        } catch (error: unknown) {
            report(error);
            code = 1;
        }
        app.exit(code);
        return;
    }
    try {
        const code: number | undefined = await runUiApp(argv, app.getPath('userData'), app.getVersion());
        if (code !== undefined) {
            app.exit(code);
        }
    } catch (error: unknown) {
        report(error);
        app.exit(1);
    }
});
