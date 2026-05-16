'use client';

import { useEffect, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';

import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

export default function MeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactElement {
  const locale = useLocale();
  const t = createTranslator(locale);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') console.error('[me] error boundary', error);
  }, [error]);
  return (
    <div role="alert" aria-live="polite" className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-2xl font-semibold">{t('web.error.title')}</h1>
      <p className="mt-2 text-muted-foreground">{t('web.error.body')}</p>
      <Button type="button" onClick={reset} className="mt-4">
        {t('web.error.retry')}
      </Button>
    </div>
  );
}
