import { getLocale } from '../../../lib/i18n/getLocale';
import { createTranslator } from '../../../lib/i18n/t';

import { AuditLogList } from './AuditLogList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h1 className="text-3xl font-semibold">{t('studio.audit.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('studio.audit.subtitle')}</p>
      </header>
      <AuditLogList />
    </section>
  );
}
