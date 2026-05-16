/**
 * Server-only locale accessor for the Athlya web app.
 *
 * Reads the `x-locale` request header set by the Edge proxy
 * (`src/proxy.ts`). The proxy already applied the full negotiation
 * logic — cookie override → `Accept-Language` → fallback — so the
 * server components can treat the header as authoritative.
 *
 * If the header is missing (e.g. an unmatched proxy route, a
 * directly-invoked test render) or contains a value outside the
 * supported set, we fall back to the product default (French) rather
 * than throwing. The render path stays resilient even when the Edge
 * plumbing is bypassed.
 *
 * @see Req 28.1, Req 28.3 — French default + English fallback.
 */
import 'server-only';

import { headers } from 'next/headers';

import type { Locale } from '@athlya/shared/i18n';

/** Supported locales, in priority order. Kept local to avoid a runtime `@athlya/api` import. */
const SUPPORTED: readonly Locale[] = ['fr', 'en'];

/** Product default — French-first. */
const DEFAULT_LOCALE: Locale = 'fr';

/**
 * Resolve the locale for the current server request.
 *
 * Returns `'fr'` when called outside a request scope or when the
 * proxy header is absent / malformed. Never throws.
 */
export async function getLocale(): Promise<Locale> {
    const h = await headers();
    const raw = h.get('x-locale');
    if (raw === null) return DEFAULT_LOCALE;
    const normalised = raw.trim().toLowerCase();
    const match = SUPPORTED.find((s) => s === normalised);
    return match ?? DEFAULT_LOCALE;
}
