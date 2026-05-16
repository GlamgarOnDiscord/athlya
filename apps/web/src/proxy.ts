/**
 * Edge proxy (Next.js 16's replacement for `middleware.ts`). Emits the
 * per-request CSP nonce, security headers, and the negotiated locale.
 *
 * Runs on every incoming HTML / navigation request. Responsibilities:
 *
 *  1. Generate a fresh 128-bit nonce via {@link generateNonce}.
 *  2. Forward the nonce to downstream server components through the
 *     `x-nonce` request header so `app/layout.tsx` can stamp inline
 *     `<style>` / `<script>` tags with `nonce={nonce}`.
 *  3. Emit the strict Content-Security-Policy response header (Req 25.3)
 *     with that nonce baked in.
 *  4. Resolve the request locale — `athlya.locale` cookie wins,
 *     otherwise `Accept-Language` is negotiated against the supported
 *     set, falling back to French (Req 28.1, 28.2, 28.3) — and forward
 *     it via the `x-locale` request header for `getLocale()` to read.
 *
 * Static headers from Req 25.4 (`X-Frame-Options`, `Referrer-Policy`,
 * etc.) are set declaratively in `next.config.ts` — doing both keeps the
 * proxy focused on what actually needs a nonce.
 *
 * Note: Next.js 16 deprecated the `middleware` file convention in favour
 * of `proxy`. The exported function must be named `proxy` (not
 * `middleware`) under the new convention.
 *
 * Tasks 10.1 (CSP/nonce) + 10.6 (locale routing).
 */
import { NextResponse } from 'next/server';


import { buildReportToHeader, generateCsp } from './lib/csp';
import { getCspReportUri, getPublicApiUrl } from './lib/env';
import { negotiateLocale } from './lib/i18n/negotiate';
import { generateNonce } from './lib/nonce';

import type { NextRequest } from 'next/server';

/**
 * Locales the web app ships bundles for, in priority order.
 * Kept local to the proxy rather than imported from
 * `@athlya/shared/i18n` so the Edge runtime avoids loading the full
 * bundle (JSON + helper) on every request — this proxy only needs
 * the three-letter-ish strings.
 */
const SUPPORTED_LOCALES = ['fr', 'en'] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Product default — French-first (Req 28.1). */
const DEFAULT_LOCALE: SupportedLocale = 'fr';

/** Cookie name used by `<LocaleSwitcher>` to override negotiation. */
const LOCALE_COOKIE = 'athlya.locale';

function isSupported(raw: string | undefined): raw is SupportedLocale {
    return raw === 'fr' || raw === 'en';
}

/**
 * Resolve the locale for this request:
 *  1. Honour the `athlya.locale` cookie when it names a supported
 *     locale (explicit user preference wins).
 *  2. Otherwise, negotiate `Accept-Language` against the supported
 *     set, falling back to the product default.
 */
function resolveLocale(request: NextRequest): SupportedLocale {
    const cookieValue = request.cookies.get(LOCALE_COOKIE)?.value;
    if (isSupported(cookieValue)) return cookieValue;
    return negotiateLocale(
        request.headers.get('accept-language'),
        SUPPORTED_LOCALES,
        DEFAULT_LOCALE,
    );
}

export function proxy(request: NextRequest): NextResponse {
    const nonce = generateNonce();
    const reportUri = getCspReportUri();
    const isDev = process.env.NODE_ENV !== 'production';
    const csp = generateCsp({
        nonce,
        apiUrl: getPublicApiUrl(),
        ...(reportUri !== undefined ? { reportUri } : {}),
        // React / Next.js inject `eval()` calls in development mode
        // for source-map stitching. The relaxation is scoped to
        // `next dev` only — production builds keep the strict
        // policy (Req 25.3).
        dev: isDev,
        // In development, Next.js dev tools inject inline styles.
        isDev,
    });
    const locale = resolveLocale(request);

    // Propagate the nonce + locale to server components through
    // request headers. `x-locale` is read by `getLocale()` in
    // `src/lib/i18n/getLocale.ts`.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('content-security-policy', csp);
    requestHeaders.set('x-locale', locale);

    const response = NextResponse.next({
        request: {
            headers: requestHeaders,
        },
    });

    response.headers.set('content-security-policy', csp);
    // Pair the CSP `report-to` directive with its `Report-To` header so
    // browsers know where to POST violation reports. Unset when no
    // endpoint is configured.
    const reportToHeader = buildReportToHeader(reportUri);
    if (reportToHeader !== undefined) {
        response.headers.set('report-to', reportToHeader);
    }
    return response;
}

/**
 * Skip static assets and Next's own internals; we only need nonces on
 * HTML responses.
 */
export const config = {
    matcher: [
        /*
         * Match all request paths except:
         * - `/_next/static` (static files)
         * - `/_next/image` (image optimisation files)
         * - `/favicon.ico` / common static files
         */
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)',
    ],
};
