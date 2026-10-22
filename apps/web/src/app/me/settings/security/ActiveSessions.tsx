'use client';

/**
 * The member's active sessions (issue #757): one row per signed-in device
 * with its last activity, this device marked, the others revocable after
 * a confirmation.
 */
import { DesktopIcon, DeviceMobileIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

import { SettingsList, SettingsRow } from '../settings-ui';

import {
  deviceLabel,
  fetchActiveSessions,
  lastSeenLabel,
  orderSessions,
  revokeActiveSession,
} from './active-sessions';

import type { ApiClient } from '../../../../lib/api/client';
import type { Translator } from '../../../../lib/i18n/t';
import type { ActiveSession } from '@athlya/shared/schemas/api';

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; sessions: ReadonlyArray<ActiveSession> }
  | { kind: 'error' };

const MOBILE_OS = new Set(['ios', 'android']);

export function ActiveSessions({
  client,
  locale,
  t,
}: {
  readonly client: Pick<ApiClient, 'get' | 'del'>;
  readonly locale: string;
  readonly t: Translator;
}): ReactElement {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [confirm, setConfirm] = useState<ActiveSession | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<'revoked' | 'failed' | null>(null);

  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchActiveSessions(client).then(
      (sessions) => !cancelled && setLoad({ kind: 'ready', sessions: orderSessions(sessions) }),
      () => !cancelled && setLoad({ kind: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [client, version]);

  const onRevoke = useCallback(async () => {
    if (confirm === null) return;
    setPending(true);
    try {
      await revokeActiveSession(client, confirm.id);
      setNotice('revoked');
      setConfirm(null);
      setVersion((v) => v + 1);
    } catch {
      setNotice('failed');
    } finally {
      setPending(false);
    }
  }, [client, confirm]);

  return (
    <section aria-labelledby="active-sessions" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="active-sessions" className="text-sm font-medium">
          {t('web.settings.security.sessions.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('web.settings.security.sessions.body')}</p>
      </div>

      <div aria-live="polite" className="text-sm">
        {notice === 'revoked' ? (
          <p className="text-muted-foreground">{t('web.settings.security.sessions.revoked')}</p>
        ) : null}
        {notice === 'failed' && confirm === null ? (
          <p role="alert" className="text-destructive">
            {t('errors.generic')}
          </p>
        ) : null}
      </div>

      {load.kind === 'loading' ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : load.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('web.settings.security.sessions.loadError')}
        </p>
      ) : (
        <SettingsList label={t('web.settings.security.sessions.title')}>
          {load.sessions.map((session) => {
            const DeviceIcon =
              session.device !== null && MOBILE_OS.has(session.device.os)
                ? DeviceMobileIcon
                : DesktopIcon;
            return (
              <SettingsRow
                key={session.id}
                title={deviceLabel(session, t)}
                description={
                  <span className="flex items-center gap-2">
                    <DeviceIcon aria-hidden="true" className="size-4 shrink-0" />
                    {lastSeenLabel(session, locale, t)}
                  </span>
                }
              >
                {session.current ? (
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium">
                    {t('web.settings.security.sessions.current')}
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setNotice(null);
                      setConfirm(session);
                    }}
                  >
                    {t('web.settings.security.sessions.revoke')}
                  </Button>
                )}
              </SettingsRow>
            );
          })}
        </SettingsList>
      )}

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirm(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('web.settings.security.sessions.revokeTitle')}</DialogTitle>
            <DialogDescription>{confirm === null ? '' : deviceLabel(confirm, t)}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('web.settings.security.sessions.revokeBody')}
          </p>
          {notice === 'failed' ? (
            <p role="alert" className="text-sm text-destructive">
              {t('errors.generic')}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                void onRevoke();
              }}
            >
              {t('web.settings.security.sessions.revokeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
