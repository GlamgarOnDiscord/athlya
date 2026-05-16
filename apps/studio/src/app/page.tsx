/**
 * Studio root — `/`.
 *
 * Static landing for the admin app. Two CTAs: sign-in for the
 * studio owner, and a link to the dashboard for already-authed
 * admins (the `<RequireAdmin>` gate redirects non-admins to
 * `/forbidden` when they reach the dashboard).
 *
 * Strings flow through `createTranslator(locale)` — no hard-coded
 * literals here.
 *
 * @see Req 25.3, Req 28.1.
 */
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';

import { getLocale } from '../lib/i18n/getLocale';
import { createTranslator } from '../lib/i18n/t';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Athlya Studio' };

export default async function StudioHome(): Promise<ReactElement> {
    const locale = await getLocale();
    const t = createTranslator(locale);

    return (
        <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-6 py-12">
            <h1 className="text-4xl font-semibold">{t('studio.home.title')}</h1>
            <p className="text-center text-lg text-muted-foreground">
                {t('studio.home.tagline')}
            </p>
            <div className="flex flex-wrap justify-center gap-4">
                <Link className={buttonVariants()} href="/login">
                    {t('auth.login.title')}
                </Link>
                <Link className={buttonVariants({ variant: 'outline' })} href="/dashboard">
                    {t('studio.home.dashboard')}
                </Link>
            </div>
        </main>
    );
}
