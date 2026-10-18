/**
 * `/dashboard/programs` — training program authoring (Epic 24, task 24.3).
 *
 * Server entry that resolves the locale and delegates to the client
 * `<ProgramsAdminList>`. Inherits the `<RequireAdmin>` gate from
 * `app/dashboard/layout.tsx`; the API's `requireRole('admin')` and RLS
 * stay the authoritative checks.
 */
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { ProgramsAdminList } from './ProgramsAdminList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Programmes' };

export default async function ProgramsAdminPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-semibold">{t('studio.programs.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.programs.subtitle')}</p>
      </header>
      <ProgramsAdminList />
    </section>
  );
}
