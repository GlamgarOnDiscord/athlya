/**
 * `/me` — server component entry.
 *
 * Resolves the request locale server-side to render the localized
 * page title, then defers the interactive work to a client subtree.
 * The data fetching lives entirely client-side because the access
 * token is held in JS memory (see `lib/auth/token-store.ts`) — a
 * server render cannot read it, so the page would fail with 401 if
 * we attempted SSR.
 *
 * Design note: the `ProfileSection` client umbrella reads the locale
 * via `useLocale()` rather than receiving a `Translator` prop from
 * this server component, because function props cannot cross the
 * RSC serialization boundary in Next.js. This mirrors the pattern
 * already established by `/login` and `/register`.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.4.
 */

import { RequireAuth } from '../../components/RequireAuth';
import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import { ProfileSection } from './ProfileSection';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Mon profil — Athlya' };

export default async function MePage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-12">
      <h1 className="text-3xl font-semibold">{t('profile.title')}</h1>
      <RequireAuth>
        <ProfileSection />
      </RequireAuth>
    </main>
  );
}
