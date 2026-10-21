'use client';

import { useMemo, type ReactElement } from 'react';

import { Separator } from '@/components/ui/separator';

import { useApiClient } from '../../../../lib/api/use-api-client';
import { useLocale } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';
import { ConsentsForm } from '../../ConsentsForm';
import { DeletePanel } from '../../delete/DeletePanel';
import { ExportPanel } from '../../export/ExportPanel';
import { MemberProfileGate } from '../../MemberProfileGate';

import type { ApiClient } from '../../../../lib/api/client';

export function PrivacyPanel({
  client: clientProp,
}: {
  readonly client?: ApiClient;
}): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const client = useApiClient(clientProp);

  return (
    <div className="flex flex-col gap-10">
      <MemberProfileGate client={client} t={t}>
        {({ consents }) => <ConsentsForm consents={consents} client={client} t={t} />}
      </MemberProfileGate>
      <Separator />
      <section aria-labelledby="privacy-export-heading" className="flex flex-col gap-4">
        <h2 id="privacy-export-heading" className="text-xl font-semibold">
          {t('rgpd.export.title')}
        </h2>
        <ExportPanel client={client} t={t} />
      </section>
      <Separator />
      <section aria-labelledby="privacy-delete-heading" className="flex flex-col gap-4">
        <h2 id="privacy-delete-heading" className="text-xl font-semibold">
          {t('rgpd.delete.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('rgpd.delete.warning')}</p>
        <DeletePanel client={client} t={t} />
      </section>
    </div>
  );
}
