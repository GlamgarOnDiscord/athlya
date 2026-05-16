/**
 * Typed access to the public environment for the studio admin app.
 *
 * Mirrors `apps/web/src/lib/env.ts`. Only `NEXT_PUBLIC_*` is read here.
 *
 * @see Requirements 26.1, 26.2 — anti-bot challenge on /login.
 */

export function getPublicApiUrl(): string {
    return process.env['NEXT_PUBLIC_API_URL'] ?? '';
}

export function getTurnstileSiteKey(): string | undefined {
    const raw = process.env['NEXT_PUBLIC_TURNSTILE_SITE_KEY'];
    if (raw === undefined || raw === '') return undefined;
    return raw;
}

export function getCspReportUri(): string | undefined {
    const raw = process.env['NEXT_PUBLIC_CSP_REPORT_URI'];
    if (raw === undefined || raw === '') return undefined;
    return raw;
}
