/**
 * `/register` — server component entry.
 *
 * Reads the per-request CSP nonce (for the Turnstile script) and the
 * resolved locale, then defers the interactive form work to a client
 * component (`RegisterForm`). Pages stay server components so the
 * initial HTML remains non-JS / crawler-friendly, while forms live in
 * client components because they own interactive state.
 *
 * @see Requirements 1.1, 1.2, 26.1, 26.2.
 */
import { headers } from 'next/headers';


import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import { RegisterForm } from './RegisterForm';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Inscription — Athlya' };

export default async function RegisterPage(): Promise<ReactElement> {
    const h = await headers();
    const nonce = h.get('x-nonce') ?? '';
    const locale = await getLocale();
    const t = createTranslator(locale);

    return (
        <main id="main-content" className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-6 py-12">
            <h1 className="text-3xl font-semibold">{t('auth.register.title')}</h1>
            <RegisterForm nonce={nonce} />
        </main>
    );
}
