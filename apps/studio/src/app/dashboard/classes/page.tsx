/**
 * `/dashboard/classes` — admin classes management.
 *
 * Server entry that resolves the locale and delegates to the client
 * `<ClassesAdminList>` component. The actual list + create + edit
 * flows live there so the auth-token-bound API client can run in the
 * browser.
 *
 * The route inherits the `<RequireAdmin>` gate from
 * `app/dashboard/layout.tsx` — non-admin users never reach this
 * page.
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.3.
 */
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { ClassesAdminList } from './ClassesAdminList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Cours' };

export default async function ClassesAdminPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-semibold">{t('studio.classes.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.classes.subtitle')}</p>
      </header>
      <ClassesAdminList />
    </section>
  );
}
