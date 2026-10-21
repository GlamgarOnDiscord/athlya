'use client';

import { useMemo, type ReactElement } from 'react';

import { useApiClient } from '../../../../lib/api/use-api-client';
import { useLocale } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';
import { MemberProfileGate } from '../../MemberProfileGate';
import { ProfileForm } from '../../ProfileForm';

import type { ApiClient } from '../../../../lib/api/client';

/** Profile form of the settings area, fed by the shared profile fetch. */
export function ProfileSettings({
  client: clientProp,
}: {
  readonly client?: ApiClient;
}): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const client = useApiClient(clientProp);

  return (
    <MemberProfileGate client={client} t={t}>
      {({ profile }) => <ProfileForm profile={profile} client={client} t={t} />}
    </MemberProfileGate>
  );
}
