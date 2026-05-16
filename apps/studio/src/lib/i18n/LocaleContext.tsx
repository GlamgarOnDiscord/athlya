/**
 * Client-side locale context for the studio admin app. Mirrors
 * `apps/web/src/lib/i18n/LocaleContext.tsx`. The root server layout
 * resolves the locale via `getLocale()`, then wraps the tree in
 * `<LocaleProvider>` so descendant client components read it via
 * `useLocale()` without prop drilling.
 *
 * @see Req 28.1.
 */
'use client';

import {
    createContext,
    use,
    type ReactElement,
    type ReactNode,
} from 'react';

import type { Locale } from '@athlya/shared/i18n';

const LocaleContext = createContext<Locale | null>(null);

export interface LocaleProviderProps {
    readonly locale: Locale;
    readonly children: ReactNode;
}

export function LocaleProvider({
    locale,
    children,
}: LocaleProviderProps): ReactElement {
    return (
        <LocaleContext.Provider value={locale}>
            {children}
        </LocaleContext.Provider>
    );
}

export function useLocale(): Locale {
    const value = use(LocaleContext);
    if (value === null) {
        throw new Error(
            'useLocale must be called within a <LocaleProvider>',
        );
    }
    return value;
}
