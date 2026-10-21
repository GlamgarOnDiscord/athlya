/**
 * `/me/settings/health`: where Apple Health is connected (the iPhone
 * app) and where its workouts land (progression). The link state lives
 * on the phone and the session list does not say which sessions were
 * imported, so the sync status is announced as coming, not invented.
 */
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button-variants';
import { cn } from '@/lib/utils';

import { RequireAuth } from '../../../../components/RequireAuth';
import { getLocale } from '../../../../lib/i18n/getLocale';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsHeader, SettingsList, SettingsRow } from '../settings-ui';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('web.settings.sections.health') };
}

export default async function HealthSettingsPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());
  const comingSoon = t('web.settings.comingSoon');
  return (
    <>
      <SettingsHeader
        title={t('web.settings.sections.health')}
        description={t('web.settings.health.description')}
      />
      <RequireAuth>
        <SettingsList>
          <SettingsRow
            title={t('web.settings.health.appleHealth.title')}
            description={t('web.settings.health.appleHealth.body')}
          >
            <Link href="/me/progression" className={cn(buttonVariants({ variant: 'outline' }))}>
              {t('web.settings.health.appleHealth.action')}
            </Link>
          </SettingsRow>
          <SettingsRow
            title={t('web.settings.health.status.title')}
            description={t('web.settings.health.status.body')}
            comingSoon={comingSoon}
          />
          <SettingsRow
            title={t('web.settings.health.devices.title')}
            description={t('web.settings.health.devices.body')}
            comingSoon={comingSoon}
          />
        </SettingsList>
      </RequireAuth>
    </>
  );
}
