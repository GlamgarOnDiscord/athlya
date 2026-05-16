/**
 * Server-only locale accessor — studio app copy.
 *
 * Reads the `x-locale` request header set by the Edge proxy
 * (`src/proxy.ts`). Falls back to French on a missing / unsupported
 * header, never throws.
 *
 * @see Req 28.1, Req 28.3.
 */
import 'server-only';

import { headers } from 'next/headers';

import type { Locale } from '@athlya/shared/i18n';

const SUPPORTED: readonly Locale[] = ['fr', 'en'];
const DEFAULT_LOCALE: Locale = 'fr';

export async function getLocale(): Promise<Locale> {
    const h = await headers();
    const raw = h.get('x-locale');
    if (raw === null) return DEFAULT_LOCALE;
    const normalised = raw.trim().toLowerCase();
    const match = SUPPORTED.find((s) => s === normalised);
    return match ?? DEFAULT_LOCALE;
}
