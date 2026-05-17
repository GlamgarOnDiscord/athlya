/**
 * `/dashboard/billing` — studio billing dashboard.
 *
 * Slice B9.3 wires the "Souscrire" button on the `pro` plan card to
 * `POST /v1/billing/checkout`. The card list itself stays a Server
 * Component (static text + plan price + i18n); the actionable button
 * is delegated to {@link BillingPlansClient}.
 *
 * Mode dégradé
 * ------------
 * Until Stripe is provisioned in production, the API returns 503
 * with `code: 'billing_not_configured'` on `POST /checkout`. The
 * client component surfaces that as a banner reading "Stripe n'est
 * pas encore configuré sur cet environnement" — see
 * `docs/runbooks/billing.md` for the cutover steps.
 *
 * @see Requirements 18.1-18.5 (Stripe billing).
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { BillingPlansClient } from './BillingPlansClient';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Facturation — Athlya Studio' };

export default async function BillingPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-semibold">{t('studio.billing.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.billing.subtitle')}</p>
      </header>

      <BillingPlansClient />

      <Card>
        <CardHeader>
          <CardTitle>{t('studio.billing.invoices.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('studio.billing.invoices.empty')}</p>
        </CardContent>
      </Card>
    </section>
  );
}
