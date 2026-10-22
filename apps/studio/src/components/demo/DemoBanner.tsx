/**
 * Banner of a demo build (issue #750). Importing this module installs the
 * demo transport before the first render, so the boot refresh of
 * `AuthProvider` already reaches the fake API. In a normal build both the
 * install and the render are folded away by the inline flag checks.
 */
'use client';

import { useMemo, type ReactElement } from 'react';

import { installDemoTransport } from '../../lib/demo/transport';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

if (process.env.NEXT_PUBLIC_DEMO_MODE === '1') installDemoTransport();

export function DemoBanner(): ReactElement | null {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== '1') return null;
  return (
    <div
      role="note"
      className="flex items-center justify-center gap-2 border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground"
    >
      <span className="rounded-full bg-foreground px-2 py-0.5 font-semibold text-background">
        {t('demo.banner.badge')}
      </span>
      <span>{t('demo.banner.text')}</span>
    </div>
  );
}
