/**
 * Custom 404 page.
 *
 * Rendered when a route is unmatched (e.g. `/register` before task 10.2
 * has implemented it). Kept static and minimal; no client-side
 * dependencies so it inherits the CSP cleanly.
 *
 * All strings resolve through the shared i18n bundle — there are no
 * hard-coded French literals here (Req 28.1).
 */
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';

import { getLocale } from '../lib/i18n/getLocale';
import { createTranslator } from '../lib/i18n/t';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Page introuvable — Athlya' };

export default async function NotFound(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-4 px-6 py-12 text-center"
    >
      <h1 className="text-3xl font-semibold">{t('web.notFound.title')}</h1>
      <p className="text-muted-foreground">{t('web.notFound.body')}</p>
      <Link className={buttonVariants()} href="/">
        {t('web.home.title')}
      </Link>
    </main>
  );
}
