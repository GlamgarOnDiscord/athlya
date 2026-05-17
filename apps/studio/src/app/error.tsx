/**
 * Root-level error boundary — studio admin copy.
 *
 * Same contract as `apps/web/src/app/error.tsx`: Next.js injects
 * `error` + `reset`, this client component renders a translated
 * fallback with retry and a link back to the dashboard.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */
'use client';

import Link from 'next/link';
import { useEffect, useMemo, type ReactElement } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';

import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';

export interface RootErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function RootError({ error, reset }: RootErrorProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  useEffect(() => {
    console.error('[studio] unhandled render error', error);
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
        <Link href="/dashboard" className={buttonVariants({ variant: 'outline' })}>
          {t('studio.home.dashboard')}
        </Link>
      </div>
    </main>
  );
}
