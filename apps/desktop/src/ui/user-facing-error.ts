// Kept apart from ipc-server.ts (which needs Electron) so modules that throw it stay testable under plain Node.

/** A handler error the user should see as it is (no stack, no "failed:" prefix). */
export class UserFacingError extends Error {
    public override readonly name: string = 'UserFacingError';
}
