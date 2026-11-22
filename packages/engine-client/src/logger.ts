// The logger the engine client writes to. The app's JSON Lines logger (packages/logging, PLAN.md, Logging)
// implements it later; until then the CLI passes a simple one. Never pass build XML or item lists in
// `data` whole: log sizes and ids, and the text of an item only when it failed to parse.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EngineLogger {
    log(level: LogLevel, message: string, data?: Readonly<Record<string, unknown>>): void;
}

export const silentLogger: EngineLogger = {
    log(): void {
        // nothing
    },
};
