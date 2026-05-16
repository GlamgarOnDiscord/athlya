/**
 * Client component that lets the user override the negotiated locale.
 *
 * Persists the choice in an `athlya.locale` cookie (1-year lifetime)
 * so every subsequent request skips the `Accept-Language` heuristic
 * (see `src/proxy.ts`). Reloads the page so the new locale propagates
 * to server components; a full reload is the simplest way to keep the
 * server / client bundles aligned without threading client-only state
 * through SSR.
 *
 * @see Req 28.1, Req 28.3 — French default + English alternative.
 * @see Task 10.6 deliverable #5.
 */
'use client';

import { type ChangeEvent, type ReactElement, useCallback } from 'react';

import { useLocale } from '../lib/i18n/LocaleContext';

import type { Locale } from '@athlya/shared/i18n';

/** Cookie name — must match the one read by `src/proxy.ts`. */
const LOCALE_COOKIE = 'athlya.locale';
/** One year in seconds — safely beyond any realistic session length. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

interface LocaleOption {
    readonly value: Locale;
    readonly label: string;
}

const OPTIONS: readonly LocaleOption[] = [
    { value: 'fr', label: 'Français' },
    { value: 'en', label: 'English' },
];

/**
 * Build the cookie serialisation string. Kept separate from the
 * handler so the test harness can intercept `document.cookie`
 * assignments without reimplementing the attributes.
 */
function serialiseCookie(locale: Locale): string {
    return `${LOCALE_COOKIE}=${locale}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

function isLocale(value: string): value is Locale {
    return value === 'fr' || value === 'en';
}

/**
 * Drop-down locale switcher — renders an accessible `<label>` + `<select>`
 * pair and persists the user's choice before a full reload.
 */
export function LocaleSwitcher(): ReactElement {
    const current = useLocale();

    const onChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
        const next = event.target.value;
        if (!isLocale(next) || next === current) return;
        document.cookie = serialiseCookie(next);
        window.location.reload();
    }, [current]);

    return (
        <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">Locale</span>
            <select
                value={current}
                onChange={onChange}
                className="rounded-md border border-border bg-transparent px-2 py-1"
                aria-label="Locale"
            >
                {OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </label>
    );
}
