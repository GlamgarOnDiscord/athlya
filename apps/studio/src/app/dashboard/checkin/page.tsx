import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { CheckinKiosk } from './CheckinKiosk';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Check-in' };

export default async function CheckinPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h1 className="text-3xl font-semibold">{t('studio.checkin.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.checkin.subtitle')}</p>
      </header>
      <CheckinKiosk />
    </section>
  );
}
