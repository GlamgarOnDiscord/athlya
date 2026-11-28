/**
 * `/dashboard/branding`: studio identity and white label.
 *
 * Slice B9.1 + B9.2 wired the page to `GET / PATCH /v1/studios/me`;
 * issue #761 adds the logos, the live contrast reading, the Athlya
 * mention of the e-mails and the custom domains. The page itself stays
 * a Server Component (locale + static layout); the actionable surfaces
 * are delegated to {@link BrandingPanel} and {@link DomainsPanel}.
 *
 * @see Requirement 13.2 (per-tenant branding), 15.2 (WCAG AA gate).
 */
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { BrandingPanel } from './BrandingPanel';
import { DomainsPanel } from './DomainsPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Branding' };

export default async function BrandingPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold">{t('studio.branding.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.branding.subtitle')}</p>
      </header>

      <BrandingPanel />

      <section aria-labelledby="branding-domains-heading" className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 id="branding-domains-heading" className="text-xl font-semibold">
            {t('studio.branding.domains.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('studio.branding.domains.help')}</p>
        </header>
        <DomainsPanel />
      </section>
    </section>
  );
}
