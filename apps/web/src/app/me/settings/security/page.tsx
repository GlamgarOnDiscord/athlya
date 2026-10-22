/**
 * `/me/settings/security`: password change through the reset-by-email
 * flow, the active sessions with revocation one by one
 * (`/v1/auth/sessions`), sign out of this device and sign out everywhere
 * (`POST /v1/auth/logout-all`).
 */
import { RequireAuth } from '../../../../components/RequireAuth';
import { getLocale } from '../../../../lib/i18n/getLocale';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsHeader } from '../settings-ui';

import { SecurityPanel } from './SecurityPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('web.settings.sections.security') };
}

export default async function SecuritySettingsPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());
  return (
    <>
      <SettingsHeader
        title={t('web.settings.sections.security')}
        description={t('web.settings.security.description')}
      />
      <RequireAuth>
        <SecurityPanel />
      </RequireAuth>
    </>
  );
}
