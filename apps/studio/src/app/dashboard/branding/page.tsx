/**
 * `/dashboard/branding` — studio branding settings.
 *
 * Slice B9.1 + B9.2 wires the previously-static page to live
 * `GET / PATCH /v1/studios/me` endpoints. The page itself stays a
 * Server Component (locale + static layout); the actionable surface
 * (read brand color, edit form) is delegated to {@link BrandingPanel}.
 *
 * @see Requirement 13.2 (per-tenant branding), 15.2 (WCAG AA gate).
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { BrandingPanel } from './BrandingPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Branding — Athlya Studio' };

export default async function BrandingPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-semibold">{t('studio.branding.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.branding.subtitle')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('studio.branding.brandColor.label')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <BrandingPanel />
          <p className="text-sm text-muted-foreground">{t('studio.branding.brandColor.help')}</p>
        </CardContent>
      </Card>
    </section>
  );
}
