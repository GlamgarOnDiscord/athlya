/**
 * Helpers that serialise the `athlya.refresh` cookie.
 *
 * The refresh token is stored as an `HttpOnly`, `Secure` (prod only),
 * `SameSite=Lax`, `Path=/api/auth` cookie — **never** readable from
 * JavaScript. Access tokens live in memory only (see `token-store.ts`);
 * the cookie holds the refresh token, which the Next.js route handlers
 * exchange for new access tokens on behalf of the browser.
 *
 * The `Path` attribute is scoped to `/api/auth` rather than `/` so the
 * cookie is only sent on the four routes that actually need it
 * (`/api/auth/login`, `/api/auth/logout`, `/api/auth/refresh`,
 * `/api/auth/register`). Every other request — including the entire
 * Next.js page surface — never sees the refresh token, which shrinks
 * the attack surface for token theft via `Set-Cookie` echo,
 * service-worker injection or third-party request leakage. The four
 * routes are the only call sites that read the cookie, verified at
 * code-review time.
 *
 * The `Secure` attribute is dropped when `isProduction === false`
 * so local development on `http://localhost` works without forcing
 * HTTPS. In production the attribute must be present — browsers will
 * reject `SameSite=None`-style cross-site usage without it, and some
 * browsers are tightening to reject any cookie lacking `Secure` when
 * served over HTTPS.
 *
 * @see Requirements 2.3 (refresh token storage), 25.2 (HTTPS
 *      enforcement surface). Sprint 1 / Slice 1.2 — Finding S4-006
 *      (cookie scope reduction).
 */

/** Cookie name — must stay in sync with every route-handler read site. */
export const REFRESH_COOKIE_NAME = 'athlya.refresh';

/**
 * URL path prefix the refresh cookie is scoped to. Every route that
 * reads or writes the cookie MUST live under this path; verified at
 * review time across `apps/web/src/app/api/auth/*`.
 *
 * Sprint 1 / Slice 1.2 — Finding S4-006.
 */
export const REFRESH_COOKIE_PATH = '/api/auth';

export interface SetRefreshCookieOptions {
    /** Opaque refresh-token string to place in the cookie's value. */
    readonly token: string;
    /** Max-Age in seconds — matches the JWT `refreshTokenExpiresIn`. */
    readonly maxAgeSec: number;
    /**
     * When `true` (production), the `Secure` attribute is emitted and
     * the cookie is only sent over HTTPS. Defaults to `true`.
     */
    readonly isProduction?: boolean;
}

/**
 * Serialise a single `Set-Cookie` header value for the refresh cookie.
 *
 * The attributes are emitted in the order Chromium's parser expects
 * (Path first, then cookie-scoped flags). The value itself is not
 * URL-encoded — JWT and opaque-random tokens are cookie-safe by
 * construction.
 */
export function buildRefreshCookie(opts: SetRefreshCookieOptions): string {
    const { token, maxAgeSec } = opts;
    const isProduction = opts.isProduction ?? true;

    if (!Number.isFinite(maxAgeSec) || maxAgeSec < 0) {
        throw new TypeError('buildRefreshCookie: maxAgeSec must be a non-negative finite number');
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

/**
 * Serialise a `Set-Cookie` value that instructs the UA to delete
 * the refresh cookie. Used by the logout and refresh-fail route
 * handlers.
 */
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
