/**
 * `/me/coach` — server component entry (Epic 21, web).
 *
 * Resolves the locale server-side for the heading and hands the data
 * work to the `<CoachPanel />` client subtree: the access token lives in
 * JS memory only, so the API calls happen client-side. The panel shows
 * the coach only when the `ai-coach` flag is on for the member.
 */

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';

import { RequireAuth } from '../../../components/RequireAuth';
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { CoachPanel } from './CoachPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('coach.title') };
}

export default async function MeCoachPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-12">
      <Link
        href="/me"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {t('common.back')}
      </Link>
      <h1 id="coach-heading" className="text-3xl font-semibold">
        {t('coach.title')}
      </h1>
      <RequireAuth>
        <CoachPanel />
      </RequireAuth>
    </main>
  );
}
