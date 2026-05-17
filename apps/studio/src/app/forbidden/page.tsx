/**
 * `/forbidden` — landing for non-admin users who reach the studio app.
 *
 * `<RequireAdmin>` redirects them here when their role is `member`
 * or `coach`. The page offers two ways out: log out (so they can
 * sign in with an admin account) and a link back to the public
 * member-facing app.
 *
 * @see Requirement 6.5.
 */
import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import { ForbiddenActions } from './ForbiddenActions';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Accès refusé — Athlya Studio' };

export default async function ForbiddenPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <h1 className="text-3xl font-semibold">{t('studio.forbidden.title')}</h1>
      <p className="text-muted-foreground">{t('studio.forbidden.body')}</p>
      <ForbiddenActions />
    </main>
  );
}
