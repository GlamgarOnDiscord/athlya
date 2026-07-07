/**
 * `/classes` — server component entry.
 *
 * Resolves the request locale server-side for the page title, then
 * wraps the interactive list in `<RequireAuth>` so only authenticated
 * members see the booking grid. Data fetching happens entirely
 * client-side because the access token lives in JS memory (see
 * `lib/auth/token-store.ts`) — a server render would fail 401.
 *
 * The client umbrella reads the locale through `useLocale()` rather
 * than accepting a `Translator` prop, because function props cannot
 * cross the RSC serialization boundary. This mirrors the pattern
 * established by `/me` in Task 10.4.
 *
 * @see Requirements 7.1, 7.2, 8.1, 8.2, 20.3.
 */

import { RequireAuth } from '../../components/RequireAuth';
import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import { ClassesList } from './ClassesList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Cours disponibles' };

export default async function ClassesPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-8 px-6 py-12">
      <h1 className="text-3xl font-semibold">{t('classes.list.title')}</h1>
      <RequireAuth>
        <ClassesList />
      </RequireAuth>
    </main>
  );
}
