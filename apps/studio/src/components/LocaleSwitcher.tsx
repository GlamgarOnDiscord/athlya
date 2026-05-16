/**
 * Locale switcher — studio admin copy of `apps/web/src/components/LocaleSwitcher.tsx`.
 *
 * Persists the user's choice in the same `athlya.locale` cookie so a
 * user who toggles locale on either app sees the change applied
 * everywhere when both apps share a parent domain in production.
 *
 * @see Req 28.1, Req 28.3.
 */
'use client';

import { type ChangeEvent, type ReactElement, useCallback } from 'react';

import { useLocale } from '../lib/i18n/LocaleContext';

import type { Locale } from '@athlya/shared/i18n';

const LOCALE_COOKIE = 'athlya.locale';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

interface LocaleOption {
  readonly value: Locale;
  readonly label: string;
}

const OPTIONS: readonly LocaleOption[] = [
  { value: 'fr', label: 'Français' },
  { value: 'en', label: 'English' },
];

function serialiseCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

function isLocale(value: string): value is Locale {
  return value === 'fr' || value === 'en';
}

export function LocaleSwitcher(): ReactElement {
  const current = useLocale();

  const onChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = event.target.value;
      if (!isLocale(next) || next === current) return;
      document.cookie = serialiseCookie(next);
      window.location.reload();
    },
    [current],
  );

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
