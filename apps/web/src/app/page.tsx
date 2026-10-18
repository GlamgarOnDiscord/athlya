/**
 * Landing / welcome page.
 *
 * Shell is a Server Component: resolves the locale via `getLocale()`,
 * renders the heading + tagline server-side. The call-to-action
 * strip is delegated to `<HomeActions />` (a Client Component) so it
 * can reflect the in-memory auth state — signed-out users see
 * Register/Login, signed-in users see Classes/Me/Logout.
 *
 * Every user-facing string flows through `createTranslator(locale)`;
 * no hard-coded French / English literals.
 *
 * @see Req 25.3 — served under the strict per-request CSP.
 * @see Req 28.1 — strings read from `@athlya/shared/i18n`, not inlined.
 */
import { AthlyaLogo } from '../components/AthlyaLogo';
import { getLocale } from '../lib/i18n/getLocale';
import { createTranslator } from '../lib/i18n/t';

import { HomeActions } from './HomeActions';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = {
  title: 'Réservez vos cours de fitness',
  alternates: { canonical: '/' },
};

export default async function HomePage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-6 py-12"
    >
      <AthlyaLogo variant="mascot" height={96} className="text-foreground" />
      <h1 className="text-4xl font-semibold">{t('web.home.title')}</h1>
      <p className="text-center text-lg text-muted-foreground">{t('web.home.tagline')}</p>
      <HomeActions />
    </main>
  );
}
