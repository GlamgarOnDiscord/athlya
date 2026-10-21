'use client';

import { useMemo, type ReactElement } from 'react';

import { LocaleSwitcher } from '../../../../components/LocaleSwitcher';
import { useLocale } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsList, SettingsRow } from '../settings-ui';

import { ThemeChoice } from './ThemeChoice';

export function PreferencesPanel(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  return (
    <SettingsList>
      <SettingsRow
        title={t('web.settings.preferences.language.title')}
        description={t('web.settings.preferences.language.body')}
      >
        <LocaleSwitcher />
      </SettingsRow>
      <SettingsRow
        title={t('web.settings.preferences.theme.title')}
        description={t('web.settings.preferences.theme.body')}
      >
        <ThemeChoice t={t} />
      </SettingsRow>
    </SettingsList>
  );
}
