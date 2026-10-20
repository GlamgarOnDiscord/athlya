/**
 * `/me/checkin` — server component entry for the member check-in QR
 * code (task 11.9, web). The token is fetched client-side by
 * `<CheckinPanel />`: the access token lives in JS memory only.
 */

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';

import { RequireAuth } from '../../../components/RequireAuth';
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { CheckinPanel } from './CheckinPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('checkin.title') };
}

export default async function MeCheckinPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 px-6 py-12">
      <Link
        href="/me"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {t('common.back')}
      </Link>
      <h1 id="checkin-heading" className="text-3xl font-semibold">
        {t('checkin.title')}
      </h1>
      <RequireAuth>
        <CheckinPanel />
      </RequireAuth>
    </main>
  );
}
