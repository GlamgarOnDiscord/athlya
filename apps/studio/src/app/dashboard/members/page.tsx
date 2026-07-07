/**
 * `/dashboard/members` — admin members directory.
 *
 * Server entry — delegates to the `<MembersAdminList>` client
 * component which reads the cursor-paginated list from
 * `GET /v1/members` (admin / coach only, scoped to the active
 * studio by the API gateway's `requireRole` + tenant claims).
 *
 * The page is gated by `<RequireAdmin>` (inherited from the
 * dashboard layout) AND by the API itself — the gateway returns
 * 403 if a non-admin / non-coach user reaches the endpoint.
 *
 * @see Requirements 3.5, 6.5.
 */
import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { MembersAdminList } from './MembersAdminList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Membres' };

export default async function MembersAdminPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h1 className="text-3xl font-semibold">{t('studio.members.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.members.subtitle')}</p>
      </header>
      <MembersAdminList />
    </section>
  );
}
