// The Electron main process: the windowed app (ui/ui-app.ts). Run from the repo root with npm run app.
// Development flags (--replay, --record-trade, --smoke and the rest) are in apps/desktop/README.md.

import { app } from 'electron';
import { runUiApp } from './ui/ui-app.ts';
import { describeError } from '@poe-upgrade-finder/validate';

// In dev (`electron apps/desktop …`) argv[1] is the app folder; the packaged exe has none (process.defaultApp
// is set only when Electron runs an app given on the command line).
const argv: readonly string[] = process.argv.slice(process.defaultApp === true ? 2 : 1);

void app.whenReady().then(async () => {
    try {
        const code: number | undefined = await runUiApp(argv, app.getPath('userData'), app.getVersion());
        if (code !== undefined) {
            app.exit(code);
        }
    } catch (error: unknown) {
        process.stderr.write(`${describeError(error)}\n`);
        app.exit(1);
    }
});
