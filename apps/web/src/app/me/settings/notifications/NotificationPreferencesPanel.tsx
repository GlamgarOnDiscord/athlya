/**
 * Per-message notification toggles (issue #762).
 *
 * Loads `GET /v1/members/me/notification-preferences`, shows one row
 * per message of the shared catalog with a checkbox per channel, and
 * saves the whole set with `PUT`. Mandatory messages (payment failure,
 * password reset) are shown locked: the API refuses to turn them off
 * and the consumer always sends them.
 */
'use client';

import { LockSimpleIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

import { useApiClient } from '../../../../lib/api/use-api-client';
import { newIdempotencyKey } from '../../../../lib/idempotency';
import { useLocale } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsList, SettingsRow } from '../settings-ui';

import { CHANNEL_KEYS, channelKeys, MEMBER_NOTIFICATIONS } from './catalogue';

import type { ApiClient } from '../../../../lib/api/client';
import type {
  NotificationChannel,
  NotificationPreferences,
  NotificationPreferencesResponse,
} from '@athlya/shared/schemas/api';

const PATH = '/v1/members/me/notification-preferences';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly saved: NotificationPreferences };

type Save = 'idle' | 'saving' | 'saved' | 'error';

type OptionalEvent = keyof NotificationPreferences;

function toggleOf(
  prefs: NotificationPreferences,
  event: OptionalEvent,
  channel: NotificationChannel,
): boolean {
  return (prefs[event] as Partial<Record<NotificationChannel, boolean>>)[channel] ?? true;
}

/** Copy of `prefs` with one toggle flipped. */
export function withToggle(
  prefs: NotificationPreferences,
  event: OptionalEvent,
  channel: NotificationChannel,
  on: boolean,
): NotificationPreferences {
  return { ...prefs, [event]: { ...prefs[event], [channel]: on } };
}

export function NotificationPreferencesPanel({
  client: clientProp,
}: {
  readonly client?: ApiClient;
}): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const client = useApiClient(clientProp);

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [save, setSave] = useState<Save>('idle');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.get<NotificationPreferencesResponse>(PATH);
        if (cancelled) return;
        setLoad({ kind: 'ready', saved: res.preferences });
        setDraft(res.preferences);
      } catch {
        if (!cancelled) setLoad({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reload]);

  const onSave = useCallback(async () => {
    if (draft === null) return;
    setSave('saving');
    try {
      const res = await client.put<NotificationPreferencesResponse>(PATH, JSON.stringify(draft), {
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newIdempotencyKey() },
      });
      setLoad({ kind: 'ready', saved: res.preferences });
      setDraft(res.preferences);
      setSave('saved');
    } catch {
      setSave('error');
    }
  }, [client, draft]);

  if (load.kind === 'loading' || (load.kind === 'ready' && draft === null)) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('web.settings.notifications.loading')}
      </p>
    );
  }
  if (load.kind === 'error' || draft === null) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm">{t('web.settings.notifications.loadError')}</p>
        <Button
          variant="outline"
          onClick={() => {
            setLoad({ kind: 'loading' });
            setReload((n) => n + 1);
          }}
        >
          {t('web.settings.notifications.retry')}
        </Button>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(load.saved);

  return (
    <div className="flex flex-col gap-4">
      <SettingsList label={t('web.settings.notifications.listLabel')}>
        {MEMBER_NOTIFICATIONS.map((notification) => {
          const title = t(notification.labelKey);
          if (notification.mandatory) {
            return (
              <SettingsRow
                key={notification.event}
                title={title}
                description={`${channelKeys(notification)
                  .map((key) => t(key))
                  .join(', ')}. ${t('web.settings.notifications.mandatory')}`}
              >
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <LockSimpleIcon aria-hidden="true" className="size-4" />
                  {t('web.settings.notifications.alwaysSent')}
                </span>
              </SettingsRow>
            );
          }
          const event = notification.event as OptionalEvent;
          return (
            <SettingsRow key={notification.event} title={title}>
              <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
                <legend className="sr-only">{title}</legend>
                {notification.channels.map((channel) => {
                  const id = `notif-${event}-${channel}`;
                  return (
                    <label key={channel} htmlFor={id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        id={id}
                        checked={toggleOf(draft, event, channel)}
                        disabled={save === 'saving'}
                        onCheckedChange={(checked) => {
                          setDraft(withToggle(draft, event, channel, checked === true));
                          setSave('idle');
                        }}
                      />
                      <span>{t(CHANNEL_KEYS[channel])}</span>
                    </label>
                  );
                })}
              </fieldset>
            </SettingsRow>
          );
        })}
      </SettingsList>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!dirty || save === 'saving'}
          onClick={() => {
            void onSave();
          }}
        >
          {save === 'saving'
            ? t('web.settings.notifications.saving')
            : t('web.settings.notifications.save')}
        </Button>
        {save === 'saved' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('web.settings.notifications.saved')}
          </p>
        ) : null}
        {save === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            {t('web.settings.notifications.saveError')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
