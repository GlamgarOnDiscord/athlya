/**
 * `/login` — server-side entry. Mirrors the web app pattern: server
 * resolves locale, renders the heading, and hands off to the client
 * `<LoginForm>`.
 *
 * @see Requirements 1.5, 2.3.
 */
import { headers } from 'next/headers';

import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import { LoginForm } from './LoginForm';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Connexion — Athlya Studio' };

export default async function LoginPage(): Promise<ReactElement> {
  const h = await headers();
  const nonce = h.get('x-nonce') ?? '';
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold">{t('studio.login.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('studio.login.subtitle')}</p>
      <LoginForm nonce={nonce} />
    </main>
  );
}
