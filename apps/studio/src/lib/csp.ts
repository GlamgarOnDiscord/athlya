/**
 * Content-Security-Policy builder for the Athlya studio admin app.
 *
 * Pinned alongside `apps/web/src/lib/csp.ts` — the two apps share the
 * same security envelope (Req 25.3). Turnstile origins stay in the
 * allowlist because the studio /login reuses the member-facing login
 * widget. The shape and strictness mirrors the web app exactly so a
 * single audit covers both surfaces.
 *
 * @see Req 25.3, Req 25.4.
 */

export interface CspOptions {
  readonly nonce: string;
  readonly apiUrl?: string;
  readonly reportUri?: string;
  readonly dev?: boolean;
  readonly isDev?: boolean;
}

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export const CSP_REPORT_GROUP = 'athlya-csp';

export function generateCsp({ nonce, apiUrl, reportUri, dev, isDev }: CspOptions): string {
  if (nonce.length === 0) {
    throw new TypeError('generateCsp: nonce must be a non-empty string');
  }

  const connectExtras = apiUrl !== undefined && apiUrl.length > 0 ? ` ${apiUrl}` : '';
  const scriptSrcExtras = dev === true ? ` 'unsafe-eval'` : '';
  const styleSrc =
    isDev === true ? `style-src 'self' 'unsafe-inline'` : `style-src 'self' 'nonce-${nonce}'`;
  // Sprint-3 SP3.1 (Vague 31, audit finding S6-001) — see
  // `apps/web/src/lib/csp.ts` for the full rationale. Studio carries
  // the same React inline-style attribute pattern (BrandingPreview
  // shares the package), so the same `style-src-attr 'unsafe-inline'`
  // mitigation applies. Strict inline-block gating preserved.
  const styleSrcAttr = isDev === true ? '' : `style-src-attr 'unsafe-inline'`;

  const directives: string[] = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${scriptSrcExtras} ${TURNSTILE_ORIGIN}`,
    styleSrc,
    ...(styleSrcAttr.length > 0 ? [styleSrcAttr] : []),
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'${connectExtras} ${TURNSTILE_ORIGIN}`,
    `frame-src 'self' ${TURNSTILE_ORIGIN}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ];

  if (reportUri !== undefined && reportUri.length > 0) {
    directives.push(`report-to ${CSP_REPORT_GROUP}`);
    directives.push(`report-uri ${reportUri}`);
  }

  return directives.join('; ');
}

export function buildReportToHeader(reportUri: string | undefined): string | undefined {
  if (reportUri === undefined || reportUri.length === 0) return undefined;
  return JSON.stringify({
    group: CSP_REPORT_GROUP,
    max_age: 86_400,
    endpoints: [{ url: reportUri }],
  });
}
