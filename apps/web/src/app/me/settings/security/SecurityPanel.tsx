'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactElement } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { useApiClient } from '../../../../lib/api/use-api-client';
import { useAuth } from '../../../../lib/auth/AuthContext';
import { useLocale } from '../../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../../lib/i18n/t';
import { SettingsList, SettingsRow } from '../settings-ui';

import { signOutEverywhere } from './sign-out-everywhere';

import type { ApiClient } from '../../../../lib/api/client';

type Pending = 'none' | 'local' | 'everywhere';

export function SecurityPanel({
  client: clientProp,
}: {
  readonly client?: ApiClient;
}): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const client = useApiClient(clientProp);
  const { logout } = useAuth();
  const { push } = useRouter();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState<Pending>('none');
  const [failed, setFailed] = useState(false);

  const onSignOut = useCallback(async () => {
    setPending('local');
    try {
      await logout();
    } catch {
      // logout() clears the local token even when its request fails.
    }
    push('/login');
  }, [logout, push]);

  const onSignOutEverywhere = useCallback(async () => {
    setPending('everywhere');
    setFailed(false);
    const done = await signOutEverywhere(client, logout);
    if (done) {
      push('/login');
      return;
    }
    setPending('none');
    setFailed(true);
  }, [client, logout, push]);

  const busy = pending !== 'none';
  const comingSoon = t('web.settings.comingSoon');

  return (
    <div className="flex flex-col gap-6">
      <SettingsList>
        <SettingsRow
          title={t('web.settings.security.password.title')}
          description={t('web.settings.security.password.body')}
        >
          <Link href="/forgot-password" className={cn(buttonVariants({ variant: 'outline' }))}>
            {t('web.settings.security.password.action')}
          </Link>
        </SettingsRow>
        <SettingsRow
          title={t('web.settings.security.sessions.title')}
          description={t('web.settings.security.sessions.body')}
          comingSoon={comingSoon}
        />
      </SettingsList>

      <SettingsList>
        <SettingsRow
          title={t('web.settings.security.signOut.title')}
          description={t('web.settings.security.signOut.body')}
        >
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void onSignOut();
            }}
          >
            {t('auth.logout')}
          </Button>
        </SettingsRow>
        <SettingsRow
          title={t('web.settings.security.signOutAll.title')}
          description={t('web.settings.security.signOutAll.body')}
        >
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setFailed(false);
              setConfirmOpen(true);
            }}
          >
            {t('web.settings.security.signOutAll.action')}
          </Button>
        </SettingsRow>
      </SettingsList>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && pending !== 'everywhere') setConfirmOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('web.settings.security.signOutAll.confirmTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('web.settings.security.signOutAll.body')}
          </p>
          <div aria-live="polite" className="text-sm">
            {pending === 'everywhere' ? (
              <p className="text-muted-foreground">
                {t('web.settings.security.signOutAll.pending')}
              </p>
            ) : null}
            {failed ? (
              <p role="alert" className="text-destructive">
                {t('errors.generic')}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending === 'everywhere'}
              onClick={() => setConfirmOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={pending === 'everywhere'}
              onClick={() => {
                void onSignOutEverywhere();
              }}
            >
              {t('web.settings.security.signOutAll.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
