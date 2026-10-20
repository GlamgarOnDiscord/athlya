/**
 * `/me/progression` — server component entry (task 22.2, web).
 *
 * Resolves the locale server-side for the heading, then hands the
 * data work to the `<ProgressionPanel />` client subtree: the access
 * token lives in JS memory only, so the API call happens client-side.
 *
 * @see Requirements 12.4, 27.1, 27.3.
 */

import { CaretLeftIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

import { RequireAuth } from '../../../components/RequireAuth';
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { ProgressionPanel } from './ProgressionPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('workouts.progression.title') };
}

export default async function MeProgressionPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-8 px-6 py-12">
      <Link
        href="/me"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <CaretLeftIcon className="size-4" aria-hidden="true" />
        {t('common.back')}
      </Link>
      <h1 id="progression-heading" className="text-3xl font-semibold">
        {t('workouts.progression.title')}
      </h1>
      <RequireAuth>
        <ProgressionPanel />
      </RequireAuth>
    </main>
  );
}
