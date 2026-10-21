/**
 * Typed access to the public environment for the Athlya web app.
 *
 * Only variables prefixed with `NEXT_PUBLIC_` are read here — everything
 * else is server-only and accessed directly via `process.env` inside
 * route handlers / server components.
 *
 * Kept intentionally small. Task 10.2 added Turnstile site-key access;
 * future tasks will extend the schema (API origin override, release
 * channel, …).
 */

/**
 * Origin of the Hono edge API the web app talks to.
 * Falls back to the current origin so local dev works without any
 * configuration — the api route is proxied via Next's rewrites.
 */
export function getPublicApiUrl(): string {
  return process.env['NEXT_PUBLIC_API_URL'] ?? '';
}

/**
 * Cloudflare Turnstile site key — used client-side by the widget on
 * `/register` and `/login`. Returns `undefined` when the key has not
 * been provisioned yet (local dev, PR preview, pre-launch staging),
 * in which case the widget renders a dev-mode warning instead of a
 * live challenge.
 *
 * The secret-side counterpart (`TURNSTILE_SECRET_KEY`) never appears
 * in this module: it is read exclusively by the Hono API gateway's
 * middleware when verifying the token server-to-server.
 *
 * @see Requirements 26.1, 26.2 — anti-bot challenge on register/login.
 */
export function getTurnstileSiteKey(): string | undefined {
  // A demo build (issue #750) never loads the widget: no form reaches the API.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === '1') return undefined;
  const raw = process.env['NEXT_PUBLIC_TURNSTILE_SITE_KEY'];
  if (raw === undefined || raw === '') return undefined;
  return raw;
}

/**
 * URL that receives Content-Security-Policy violation reports. When
 * set, the proxy emits `report-to` + `report-uri` CSP directives plus a
 * matching `Report-To` response header, so browsers POST a JSON body
 * whenever a resource is blocked. When unset (local dev, CI), the CSP
 * is emitted without the reporting directives and browsers silently
 * enforce it.
 *
 * The endpoint is expected to accept `application/csp-report` or
 * `application/reports+json` payloads — see
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP#reporting.
 */
export function getCspReportUri(): string | undefined {
  const raw = process.env['NEXT_PUBLIC_CSP_REPORT_URI'];
  if (raw === undefined || raw === '') return undefined;
  return raw;
}

/**
 * Returns true when the cookie `Secure` flag should be set.
 *
 * Defaults to true (fail-closed) so a missing or mistyped APP_ENV does
 * not silently downgrade cookie security in a deployed environment.
 * Only `APP_ENV=development` (local dev / CI) skips the flag.
 */
export function isSecureCookieEnv(): boolean {
  const env = process.env['APP_ENV'];
  return env !== 'development';
}
