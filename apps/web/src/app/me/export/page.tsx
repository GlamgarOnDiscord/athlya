/**
 * `/me/export` — server component entry.
 *
 * Resolves the request locale server-side to render the localized
 * page title, then defers the interactive request + status work to a
 * client subtree. Access-token-dependent calls happen client-side
 * because the token lives in JS memory only.
 *
 * @see Requirements 4.1, 5.1.
 */

import { CaretLeftIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

import { RequireAuth } from '../../../components/RequireAuth';
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { ExportPanel } from './ExportPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Exporter mes données' };

export default async function MeExportPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-12">
      <Link
        href="/me"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <CaretLeftIcon className="size-4" aria-hidden="true" />
        {t('common.back')}
      </Link>
      <h1 className="text-3xl font-semibold">{t('rgpd.export.title')}</h1>
      <RequireAuth>
        <ExportPanel />
      </RequireAuth>
    </main>
  );
}
