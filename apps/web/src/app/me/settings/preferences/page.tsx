/**
 * `/me/settings/preferences`: language (the `athlya.locale` cookie) and
 * theme (next-themes). Both live in this browser: the API stores no
 * member preference.
 */
import { RequireAuth } from '../../../../components/RequireAuth';
import { getLocale } from '../../../../lib/i18n/getLocale';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsHeader } from '../settings-ui';

import { PreferencesPanel } from './PreferencesPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('web.settings.sections.preferences') };
}

export default async function PreferencesSettingsPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());
  return (
    <>
      <SettingsHeader
        title={t('web.settings.sections.preferences')}
        description={t('web.settings.preferences.description')}
      />
      <RequireAuth>
        <PreferencesPanel />
      </RequireAuth>
    </>
  );
}
