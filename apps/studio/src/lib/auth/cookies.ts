/**
 * Refresh-cookie helpers for the studio admin app.
 *
 * The refresh token sits in `athlya.refresh.studio` — a different name
 * than the member-facing app's `athlya.refresh` so signing into
 * studio.localhost vs. localhost doesn't fight over the same cookie
 * during local development. In production both apps live under
 * different sub-domains and the host attribute already keeps them
 * isolated, but using a distinct name keeps a single browser profile
 * able to hold both an admin and a member session simultaneously.
 *
 * The `Path` attribute is scoped to `/api/auth` so the cookie only
 * ships on the studio's auth-handling routes (`/api/auth/login`,
 * `/api/auth/logout`, `/api/auth/refresh`). Every other request —
 * dashboard pages, billing, classes — never sees the refresh token.
 * Sprint 1 / Slice 1.2 — Finding S4-006 (cookie scope reduction).
 *
 * @see Requirements 2.3.
 */

export const REFRESH_COOKIE_NAME = 'athlya.refresh.studio';

/**
 * URL path prefix the refresh cookie is scoped to. Every route that
 * reads or writes the cookie MUST live under this path.
 *
 * Sprint 1 / Slice 1.2 — Finding S4-006.
 */
export const REFRESH_COOKIE_PATH = '/api/auth';

export interface SetRefreshCookieOptions {
    readonly token: string;
    readonly maxAgeSec: number;
    readonly isProduction?: boolean;
}

export function buildRefreshCookie(opts: SetRefreshCookieOptions): string {
    const { token, maxAgeSec } = opts;
    const isProduction = opts.isProduction ?? true;

    if (!Number.isFinite(maxAgeSec) || maxAgeSec < 0) {
        throw new TypeError(
            'buildRefreshCookie: maxAgeSec must be a non-negative finite number',
        );
    }

    const parts: string[] = [
        `${REFRESH_COOKIE_NAME}=${token}`,
        `Path=${REFRESH_COOKIE_PATH}`,
        `Max-Age=${Math.floor(maxAgeSec)}`,
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (isProduction) {
        parts.push('Secure');
    }
    return parts.join('; ');
}

export function buildClearRefreshCookie(isProduction = true): string {
    const parts: string[] = [
        `${REFRESH_COOKIE_NAME}=`,
        `Path=${REFRESH_COOKIE_PATH}`,
        'Max-Age=0',
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (isProduction) {
        parts.push('Secure');
    }
    return parts.join('; ');
}
