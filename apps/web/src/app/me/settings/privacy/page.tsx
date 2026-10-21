/**
 * `/me/settings/privacy`: consents (`PATCH /v1/members/me/consents`),
 * data export (`POST /v1/members/me/export`) and account deletion
 * (`DELETE /v1/auth/me`), through the existing forms and panels.
 */
import { RequireAuth } from '../../../../components/RequireAuth';
import { getLocale } from '../../../../lib/i18n/getLocale';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsHeader } from '../settings-ui';

import { PrivacyPanel } from './PrivacyPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('web.settings.sections.privacy') };
}

export default async function PrivacySettingsPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());
  return (
    <>
      <SettingsHeader
        title={t('web.settings.sections.privacy')}
        description={t('web.settings.privacy.description')}
      />
      <RequireAuth>
        <PrivacyPanel />
      </RequireAuth>
    </>
  );
}
