/**
 * `/me/settings/profile`: display name and picture
 * (`GET`/`PATCH /v1/members/me`, `PUT /v1/members/me/avatar`).
 */
import { RequireAuth } from '../../../../components/RequireAuth';
import { getLocale } from '../../../../lib/i18n/getLocale';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsHeader } from '../settings-ui';

import { ProfileSettings } from './ProfileSettings';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('web.settings.sections.profile') };
}

export default async function ProfileSettingsPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());
  return (
    <>
      <SettingsHeader
        title={t('web.settings.sections.profile')}
        description={t('web.settings.profile.description')}
      />
      <RequireAuth>
        <ProfileSettings />
      </RequireAuth>
    </>
  );
}
