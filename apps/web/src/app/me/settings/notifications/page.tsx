/**
 * `/me/settings/notifications`: the messages a member receives, with a
 * toggle per message and channel (issue #762). Mandatory messages stay
 * locked; marketing lives under the consents of the privacy section.
 */
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button-variants';
import { cn } from '@/lib/utils';

import { RequireAuth } from '../../../../components/RequireAuth';
import { getLocale } from '../../../../lib/i18n/getLocale';
import { createTranslator } from '../../../../lib/i18n/t';
import { SETTINGS_PATHS } from '../routes';
import { SettingsHeader, SettingsList, SettingsRow } from '../settings-ui';

import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getLocale());
  return { title: t('web.settings.sections.notifications') };
}

export default async function NotificationsSettingsPage(): Promise<ReactElement> {
  const t = createTranslator(await getLocale());
  return (
    <>
      <SettingsHeader
        title={t('web.settings.sections.notifications')}
        description={t('web.settings.notifications.description')}
      />
      <RequireAuth>
        <div className="flex flex-col gap-6">
          <NotificationPreferencesPanel />
          <SettingsList>
            <SettingsRow
              title={t('web.settings.notifications.marketing.title')}
              description={t('web.settings.notifications.marketing.body')}
            >
              <Link
                href={SETTINGS_PATHS.privacy}
                className={cn(buttonVariants({ variant: 'outline' }))}
              >
                {t('web.settings.notifications.marketing.action')}
              </Link>
            </SettingsRow>
          </SettingsList>
        </div>
      </RequireAuth>
    </>
  );
}
