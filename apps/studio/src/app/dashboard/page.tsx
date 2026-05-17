/**
 * `/dashboard` — admin landing.
 *
 * Pure presentational summary of the four sections delivered across
 * Slice 12.B (classes), 12.C (members + branding), and 12.D
 * (billing). Each card links to the matching `/dashboard/<section>`
 * route — those pages 404 cleanly until their slice lands.
 *
 * @see Task 12.1.
 */
import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Dashboard — Athlya Studio' };

interface SectionLink {
  readonly href: string;
  readonly titleKey:
    | 'studio.dashboard.classes.title'
    | 'studio.dashboard.members.title'
    | 'studio.dashboard.branding.title'
    | 'studio.dashboard.billing.title';
  readonly bodyKey:
    | 'studio.dashboard.classes.body'
    | 'studio.dashboard.members.body'
    | 'studio.dashboard.branding.body'
    | 'studio.dashboard.billing.body';
}

const SECTIONS: ReadonlyArray<SectionLink> = [
  {
    href: '/dashboard/classes',
    titleKey: 'studio.dashboard.classes.title',
    bodyKey: 'studio.dashboard.classes.body',
  },
  {
    href: '/dashboard/members',
    titleKey: 'studio.dashboard.members.title',
    bodyKey: 'studio.dashboard.members.body',
  },
  {
    href: '/dashboard/branding',
    titleKey: 'studio.dashboard.branding.title',
    bodyKey: 'studio.dashboard.branding.body',
  },
  {
    href: '/dashboard/billing',
    titleKey: 'studio.dashboard.billing.title',
    bodyKey: 'studio.dashboard.billing.body',
  },
];

export default async function DashboardHome(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold">{t('studio.dashboard.title')}</h1>
      <p className="text-muted-foreground">{t('studio.dashboard.subtitle')}</p>
      <ul className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <li key={section.href}>
            <Card className="transition hover:border-primary">
              <Link href={section.href} className="block">
                <CardHeader>
                  <CardTitle className="text-lg">{t(section.titleKey)}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{t(section.bodyKey)}</p>
                </CardContent>
              </Link>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
