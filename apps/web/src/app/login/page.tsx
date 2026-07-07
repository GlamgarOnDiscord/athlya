/**
 * `/login` — server component entry.
 *
 * See `app/register/page.tsx` for the rationale on the server +
 * client split. The login form itself lives in `./LoginForm.tsx`.
 *
 * @see Requirements 1.5, 2.3, 26.1, 26.2.
 */
import { headers } from 'next/headers';

import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import { LoginForm } from './LoginForm';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = {
  title: 'Connexion',
  alternates: { canonical: '/login' },
  robots: { index: false, follow: false },
};

export default async function LoginPage(): Promise<ReactElement> {
  const h = await headers();
  const nonce = h.get('x-nonce') ?? '';
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12"
    >
      <h1 className="text-3xl font-semibold">{t('auth.login.title')}</h1>
      <LoginForm nonce={nonce} />
    </main>
  );
}
