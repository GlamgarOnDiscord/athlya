/**
 * `/dashboard` — admin landing.
 *
 * Server entry: resolves the locale for the heading and hands off to the
 * client `<DashboardOverview>`, which reads the studio's classes, member
 * count and latest admin actions with the authenticated API client.
 *
 * @see Task 12.1, docs/design/ui-direction.md ("Dashboard grid").
 */
import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import { DashboardOverview } from './DashboardOverview';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardHome(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-semibold">{t('studio.dashboard.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.dashboard.subtitle')}</p>
      </header>
      <DashboardOverview />
    </section>
  );
}
