/**
 * Client-side locale context for the Athlya web app.
 *
 * The root server layout resolves the locale (via `getLocale()`), then
 * wraps the tree in `<LocaleProvider locale={locale}>` so descendant
 * client components can read the value synchronously through
 * `useLocale()` — no request-scoped imports, no prop drilling.
 *
 * Keeping the provider minimal: it exposes the raw locale string. The
 * translator itself is re-created on demand with `createTranslator`
 * because React's reconciler already de-dupes identical string props
 * and components typically only need `t()` at render time.
 *
 * @see Req 28.1 — every component reads translations from the shared
 *      bundle via the locale provided here.
 */
'use client';

import {
    createContext,
    use,
    type ReactElement,
    type ReactNode,
} from 'react';

import type { Locale } from '@athlya/shared/i18n';

/**
 * Null sentinel means "provider missing" — distinct from a missing
 * locale value so `useLocale()` can throw a targeted developer error
 * instead of silently defaulting.
 */
const LocaleContext = createContext<Locale | null>(null);

export interface LocaleProviderProps {
    readonly locale: Locale;
    readonly children: ReactNode;
}

/**
 * Provide the resolved locale to every descendant. Expected to be
 * mounted exactly once, near the root of the tree (see `app/layout.tsx`).
 */
export function LocaleProvider({ locale, children }: LocaleProviderProps): ReactElement {
    return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/**
 * Read the current locale from context.
 *
 * Throws when called outside a `<LocaleProvider>` — the app's root
 * layout always mounts one, so a missing provider always signals a
 * broken render tree in development.
 */
export function useLocale(): Locale {
    const value = use(LocaleContext);
    if (value === null) {
        throw new Error('useLocale must be called within a <LocaleProvider>');
    }
    return value;
}
