/**
 * Edge proxy for the studio admin app. Same shape as
 * `apps/web/src/proxy.ts` — emits the per-request CSP nonce, security
 * headers, and the negotiated locale. The admin role gate is handled
 * client-side (`<RequireAdmin>`) and server-side by the API gateway
 * (`requireRole('admin')`); the proxy itself is role-agnostic.
 *
 * Tasks 12.1 (scaffolding) + 12.2 (auth-protected layout).
 */
import { NextResponse } from 'next/server';

import { buildReportToHeader, generateCsp } from './lib/csp';
import { getCspReportUri, getPublicApiUrl } from './lib/env';
import { negotiateLocale } from './lib/i18n/negotiate';
import { generateNonce } from './lib/nonce';

import type { NextRequest } from 'next/server';

const SUPPORTED_LOCALES = ['fr', 'en'] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const DEFAULT_LOCALE: SupportedLocale = 'fr';
const LOCALE_COOKIE = 'athlya.locale';

function isSupported(raw: string | undefined): raw is SupportedLocale {
  return raw === 'fr' || raw === 'en';
}

function resolveLocale(request: NextRequest): SupportedLocale {
  const cookieValue = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isSupported(cookieValue)) return cookieValue;
  return negotiateLocale(request.headers.get('accept-language'), SUPPORTED_LOCALES, DEFAULT_LOCALE);
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const reportUri = getCspReportUri();
  const isDev = process.env.NODE_ENV !== 'production';
  const csp = generateCsp({
    nonce,
    apiUrl: getPublicApiUrl(),
    ...(reportUri !== undefined ? { reportUri } : {}),
    dev: isDev,
    isDev,
  });
  const locale = resolveLocale(request);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  requestHeaders.set('x-locale', locale);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set('content-security-policy', csp);
  const reportToHeader = buildReportToHeader(reportUri);
  if (reportToHeader !== undefined) {
    response.headers.set('report-to', reportToHeader);
  }
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)',
  ],
};
