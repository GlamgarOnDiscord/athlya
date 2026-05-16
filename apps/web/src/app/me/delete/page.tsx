/**
 * `/me/delete` — server component entry.
 *
 * Resolves the request locale server-side and defers the interactive
 * confirm-and-destroy flow to the client panel. The panel lives in a
 * client subtree because it drives a modal, reads the in-memory
 * access token, and triggers router navigation after the DELETE
 * succeeds.
 *
 * @see Requirements 4.1, 5.1.
 */

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';

import { RequireAuth } from '../../../components/RequireAuth';
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { DeletePanel } from './DeletePanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Supprimer mon compte — Athlya' };

export default async function MeDeletePage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-12">
      <Link
        href="/me"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {t('common.back')}
      </Link>
      <h1 className="text-3xl font-semibold">{t('rgpd.delete.title')}</h1>
      <RequireAuth>
        <DeletePanel />
      </RequireAuth>
    </main>
  );
}
