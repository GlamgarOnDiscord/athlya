/**
 * `/me/settings/notifications`: the booking messages a member receives
 * and their channels. Read-only: every one is transactional and the API
 * has no per-event preference yet, which the page says.
 */
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button-variants';
import { cn } from '@/lib/utils';

import { RequireAuth } from '../../../../components/RequireAuth';
import { getLocale } from '../../../../lib/i18n/getLocale';
import { createTranslator } from '../../../../lib/i18n/t';
import { SETTINGS_PATHS } from '../routes';
import { SettingsHeader, SettingsList, SettingsRow } from '../settings-ui';

import { channelKeys, MEMBER_NOTIFICATIONS } from './catalogue';

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
          <p className="text-sm text-muted-foreground">
            {t('web.settings.notifications.transactional')}
          </p>
          <SettingsList label={t('web.settings.notifications.listLabel')}>
            {MEMBER_NOTIFICATIONS.map((notification) => (
              <SettingsRow
                key={notification.event}
                title={t(notification.labelKey)}
                description={channelKeys(notification)
                  .map((key) => t(key))
                  .join(', ')}
              >
                <span className="text-sm text-muted-foreground">
                  {t('web.settings.notifications.alwaysSent')}
                </span>
              </SettingsRow>
            ))}
          </SettingsList>
          <SettingsList>
            <SettingsRow
              title={t('web.settings.notifications.perEvent.title')}
              description={t('web.settings.notifications.perEvent.body')}
              comingSoon={t('web.settings.comingSoon')}
            />
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
