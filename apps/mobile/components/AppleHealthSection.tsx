import * as Crypto from 'expo-crypto';
import { useMemo, useState } from 'react';
import { Text } from 'react-native';

import { formatLocalDate } from '../features/format';
import {
  connectAppleHealth,
  disconnectAppleHealth,
  healthNotice,
  importAppleHealthWorkouts,
  stoppedNotice,
  type AppleHealthDeps,
  type HealthNotice,
} from '../features/health/apple-health';

import { useWriteDeps } from './AppSession';
import { ErrorNotice } from './ErrorNotice';
import { useRuntime } from './RuntimeProvider';
import { AppText } from './ui/AppText';
import { Button } from './ui/Button';
import { Notice } from './ui/Notice';

import type { ErrorModel } from '../features/errors';
import type { AppleHealthLink } from '../infrastructure/health/link-store';

const sha256 = (input: string): Promise<string> =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);

/** `YYYY-MM-DD` of an instant in the device time zone. */
function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Apple Health settings (task 18.1): connect, import now, disconnect.
 * Rendered on iOS only by the settings screen.
 */
export function AppleHealthSection({ userId }: { readonly userId: string }) {
  const runtime = useRuntime();
  const { t, locale, health, healthLinks } = runtime;
  const writes = useWriteDeps();
  const deps = useMemo<AppleHealthDeps>(
    () => ({
      health,
      links: healthLinks,
      api: runtime.api,
      writes,
      sha256,
      t,
      locale,
      now: Date.now,
    }),
    [health, healthLinks, runtime.api, writes, t, locale],
  );

  const [link, setLink] = useState<AppleHealthLink | null>(() => healthLinks.get(userId));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<HealthNotice | null>(null);
  const [stopped, setStopped] = useState<HealthNotice | null>(null);
  const [error, setError] = useState<ErrorModel | null>(null);

  const begin = () => {
    setBusy(true);
    setNotice(null);
    setStopped(null);
    setError(null);
  };

  const onConnect = () => {
    begin();
    void connectAppleHealth(deps, userId).then((result) => {
      setLink(healthLinks.get(userId));
      setNotice(healthNotice(result));
      if (result.kind === 'error') setError(result.error);
      setBusy(false);
    });
  };

  const onImport = () => {
    begin();
    void importAppleHealthWorkouts(deps, userId).then((result) => {
      setLink(healthLinks.get(userId));
      setNotice(healthNotice(result));
      setStopped(stoppedNotice(result));
      if (result.kind === 'error') setError(result.error);
      setBusy(false);
    });
  };

  const onDisconnect = () => {
    disconnectAppleHealth(healthLinks, userId);
    setLink(null);
    setStopped(null);
    setError(null);
    setNotice({ key: 'mobile.health.disconnected', tone: 'info' });
  };

  return (
    <>
      <Text
        accessibilityRole="header"
        className="text-xl font-bold text-foreground dark:text-dark-foreground"
      >
        {t('mobile.health.title')}
      </Text>
      <AppText variant="muted">{t('mobile.health.description')}</AppText>
      {link === null ? (
        <Button
          title={t('mobile.health.connect')}
          accessibilityHint={t('mobile.health.connectHint')}
          busy={busy}
          onPress={onConnect}
        />
      ) : (
        <>
          <AppText>
            {t('mobile.health.connectedSince', {
              date: formatLocalDate(localDay(link.sinceMs), locale),
            })}
          </AppText>
          <Button
            title={t('mobile.health.importNow')}
            accessibilityHint={t('mobile.health.importNowHint')}
            busy={busy}
            onPress={onImport}
          />
          <Button
            title={t('mobile.health.disconnect')}
            accessibilityHint={t('mobile.health.disconnectHint')}
            variant="secondary"
            disabled={busy}
            onPress={onDisconnect}
          />
        </>
      )}
      {notice === null ? null : (
        <Notice tone={notice.tone} message={t(notice.key, notice.values)} />
      )}
      {stopped === null ? null : <Notice message={t(stopped.key, stopped.values)} />}
      {error === null ? null : <ErrorNotice error={error} />}
    </>
  );
}
