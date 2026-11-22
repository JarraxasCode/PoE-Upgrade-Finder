// Where the sign-in window may go (PLAN.md, D10: pathofexile.com and its login providers). Pure, so it is
// unit-tested without Electron.

/** Hosts the sign-in window may navigate to: the site and its login providers. Anything else is blocked. */
export const ALLOWED_HOSTS: readonly RegExp[] = [
    /(^|\.)pathofexile\.com$/,
    /(^|\.)steampowered\.com$/,
    /(^|\.)steamcommunity\.com$/,
    /(^|\.)epicgames\.com$/,
    /(^|\.)playstation\.com$/,
    /(^|\.)sonyentertainmentnetwork\.com$/,
    /(^|\.)live\.com$/,
    /(^|\.)microsoft\.com$/,
    /(^|\.)microsoftonline\.com$/,
    /(^|\.)xboxlive\.com$/,
    /(^|\.)xbox\.com$/,
    /(^|\.)cloudflare\.com$/,
];

export function isAllowedSignInUrl(url: string): boolean {
    try {
        const u: URL = new URL(url);
        return u.protocol === 'https:' && ALLOWED_HOSTS.some((r: RegExp) => r.test(u.hostname));
    } catch {
        return false;
    }
}
