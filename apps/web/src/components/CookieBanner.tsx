/**
 * Cookie / analytics consent banner — Sprint-6 Slice 6.1
 * (Vague 34, audit finding S5-009).
 *
 * Renders a fixed-bottom banner the first time a visitor lands on
 * the site (or after the 13-month CNIL window has elapsed). The
 * banner offers three actions:
 *
 *   - **Tout accepter** : `analytics = true`, `errorTracking = true`.
 *   - **Personnaliser** : opens an inline detail panel with one
 *     toggle per category. Avoids dark-pattern asymmetry — refus
 *     and acceptance carry the same UX cost.
 *   - **Tout refuser** : both flags false. Banner closes.
 *
 * The banner does NOT load any SDK. It only persists the choice in
 * `localStorage` via {@link writeAnalyticsConsent}. The actual SDK
 * init (Plausible, Sentry browser, …) reads the consent state on
 * mount via `useAnalyticsConsent()` and bails when the flag is
 * `false`.
 *
 * Important: this component is `"use client"` because it reads /
 * writes `localStorage`. Pages that render it (`apps/web/src/app/layout.tsx`
 * once wired in a follow-up slice) must opt in via a client-only
 * boundary or the banner JSX itself.
 *
 * @see apps/web/src/lib/analytics-consent.ts
 * @see docs/security/audit-S5-rgpd.md S5-009
 */
'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';


import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

import {
  DEFAULT_CONSENT,
  readAnalyticsConsent,
  shouldPromptForConsent,
  writeAnalyticsConsent,
} from '../lib/analytics-consent';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';

import type { AnalyticsConsent } from '../lib/analytics-consent';

/**
 * Internal panel mode discriminator.
 *   - `'hidden'`   — banner not rendered (consent already given).
 *   - `'collapsed'` — banner shown with the three top-level CTAs.
 *   - `'expanded'`  — detail panel shown with per-category toggles.
 */
type Mode = 'hidden' | 'collapsed' | 'expanded';

export function CookieBanner() {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const [mode, setMode] = useState<Mode>(() => {
    if (typeof window === 'undefined') return 'hidden';
    return shouldPromptForConsent() ? 'collapsed' : 'hidden';
  });
  const [draft, setDraft] = useState<AnalyticsConsent>(() => {
    if (typeof window === 'undefined') return DEFAULT_CONSENT;
    return shouldPromptForConsent() ? readAnalyticsConsent() : DEFAULT_CONSENT;
  });

  const persist = (next: { analytics: boolean; errorTracking: boolean }) => {
    writeAnalyticsConsent(next);
    setMode('hidden');
  };

  const acceptAll = () => persist({ analytics: true, errorTracking: true });
  const refuseAll = () => persist({ analytics: false, errorTracking: false });
  const saveCustom = () =>
    persist({
      analytics: draft.analytics,
      errorTracking: draft.errorTracking,
    });

  if (mode === 'hidden') return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-banner-title"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background p-4 shadow-lg sm:p-6"
    >
      <div className="mx-auto max-w-3xl">
        <h2 id="cookie-banner-title" className="text-lg font-semibold text-foreground">
          {t('web.cookieBanner.title')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('web.cookieBanner.description')}{' '}
          <Link href="/cookies" className="underline hover:text-foreground">
            {t('web.cookieBanner.cookiePolicy')}
          </Link>
          .
        </p>

        {mode === 'expanded' && (
          <fieldset className="mt-4 space-y-3 border-t border-border pt-4">
            <legend className="sr-only">{t('web.cookieBanner.categories.legend')}</legend>
            <div className="flex items-start gap-3">
              <Checkbox
                id="cookie-analytics"
                className="mt-0.5"
                checked={draft.analytics}
                onCheckedChange={(checked) =>
                  setDraft((prev) => ({
                    ...prev,
                    analytics: checked === true,
                  }))
                }
              />
              <Label htmlFor="cookie-analytics" className="text-sm font-normal">
                <strong>{t('web.cookieBanner.categories.analytics.title')}</strong>
                <br />
                <span className="text-muted-foreground">
                  {t('web.cookieBanner.categories.analytics.description')}
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox
                id="cookie-error-tracking"
                className="mt-0.5"
                checked={draft.errorTracking}
                onCheckedChange={(checked) =>
                  setDraft((prev) => ({
                    ...prev,
                    errorTracking: checked === true,
                  }))
                }
              />
              <Label htmlFor="cookie-error-tracking" className="text-sm font-normal">
                <strong>{t('web.cookieBanner.categories.errorTracking.title')}</strong>
                <br />
                <span className="text-muted-foreground">
                  {t('web.cookieBanner.categories.errorTracking.description')}
                </span>
              </Label>
            </div>
          </fieldset>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={refuseAll}>
            {t('web.cookieBanner.refuseAll')}
          </Button>
          {mode === 'collapsed' ? (
            <Button variant="outline" onClick={() => setMode('expanded')}>
              {t('web.cookieBanner.customize')}
            </Button>
          ) : (
            <Button variant="outline" onClick={saveCustom}>
              {t('web.cookieBanner.save')}
            </Button>
          )}
          <Button onClick={acceptAll}>{t('web.cookieBanner.acceptAll')}</Button>
        </div>
      </div>
    </div>
  );
}
