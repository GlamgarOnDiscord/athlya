/**
 * Root-level error boundary.
 *
 * Rendered by Next.js when anything in the app tree throws during
 * render, data fetching, or on the client. The framework injects two
 * props:
 *
 *   - `error`  — the caught `Error`. The message is scrubbed of
 *                server-side stack traces in production, so surfacing
 *                it directly is safe. We still display a generic
 *                translated fallback for polish.
 *   - `reset`  — a callback that re-mounts the segment below the
 *                boundary. Users click the retry button to attempt a
 *                fresh render without a full page reload.
 *
 * Must be a Client Component (`'use client'`) per Next.js 16 App
 * Router convention — the `reset` callback is a client-side handler
 * and the boundary has to hydrate in the browser to attach it.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */
'use client';

import Link from 'next/link';
import { useEffect, useMemo, type ReactElement } from 'react';

import { Button , buttonVariants } from '@/components/ui/button';


import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';

export interface RootErrorProps {
    readonly error: Error & { digest?: string };
    readonly reset: () => void;
}

export default function RootError({
    error,
    reset,
}: RootErrorProps): ReactElement {
    const locale = useLocale();
    const t = useMemo(() => createTranslator(locale), [locale]);

    // Log to the browser console for local dev / CI. Production builds
    // ship a separate observability integration (Sentry via the API
    // gateway) so surfacing the error here never loses it even if the
    // remote pipeline is down.
    useEffect(() => {
        if (process.env.NODE_ENV !== 'production') {
            console.error('[RootError] unhandled render error', error);
        }
    }, [error]);

    return (
        <main
            role="alert"
            aria-live="assertive"
            className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-4 px-6 py-12 text-center"
        >
            <h1 className="text-3xl font-semibold">{t('web.error.title')}</h1>
            <p className="text-muted-foreground">{t('web.error.body')}</p>
            <div className="flex flex-wrap justify-center gap-3">
                <Button type="button" onClick={reset}>
                    {t('web.error.retry')}
                </Button>
                <Link href="/" className={buttonVariants({ variant: 'outline' })}>
                    {t('web.error.home')}
                </Link>
            </div>
        </main>
    );
}
