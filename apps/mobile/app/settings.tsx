import * as Crypto from 'expo-crypto';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';

import { SignedIn, useDeadLetters, useSessionStore } from '../components/AppSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { TextField } from '../components/ui/TextField';
import { ToggleRow } from '../components/ui/ToggleRow';
import { signOut } from '../features/auth/auth';
import { formatDateTime } from '../features/format';
import {
  deleteAccount,
  isDeleteConfirmed,
  rejectedChanges,
  requestDataExport,
  toggleBiometricUnlock,
  type DeleteResult,
  type ExportResult,
} from '../features/settings/settings';

import type { TranslationKeys } from '@athlya/shared/i18n';

function SectionTitle({ children }: { readonly children: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="text-xl font-bold text-foreground dark:text-dark-foreground"
    >
      {children}
    </Text>
  );
}

function Settings({ userId }: { readonly userId: string }) {
  const runtime = useRuntime();
  const { t, locale, tokenStore, queue } = runtime;
  const session = useSessionStore();
  const router = useRouter();
  const deadLetters = useDeadLetters(userId);
  const rejected = rejectedChanges(deadLetters);

  const [biometric, setBiometric] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(true);
  const [biometricRefused, setBiometricRefused] = useState<TranslationKeys | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState<DeleteResult | null>(null);

  useEffect(() => {
    let active = true;
    tokenStore
      .isBiometricUnlockEnabled()
      .then((enabled) => {
        if (active) setBiometric(enabled);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setBiometricBusy(false);
      });
    return () => {
      active = false;
    };
  }, [tokenStore]);

  const onToggleBiometric = (enabled: boolean) => {
    setBiometricBusy(true);
    setBiometricRefused(null);
    void toggleBiometricUnlock(tokenStore, enabled).then((result) => {
      setBiometric(result.enabled);
      if (result.failed) {
        setBiometricRefused(
          enabled
            ? 'mobile.settings.biometric.unavailable'
            : 'mobile.settings.biometric.disableFailed',
        );
      }
      setBiometricBusy(false);
    });
  };

  /** Leaves the signed-in area; local cleanup problems are reported, never block. */
  const leave = (cleanupFailed: boolean) => {
    if (cleanupFailed) {
      Alert.alert(
        t('mobile.settings.cleanupFailed.title'),
        t('mobile.settings.cleanupFailed.message'),
      );
    }
    void session
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        router.replace('/login');
      });
  };

  const onSignOut = () => {
    setSigningOut(true);
    signOut(runtime)
      .then((cleared) => {
        leave(!cleared);
      })
      .catch(() => {
        leave(true);
      });
  };

  const onExport = () => {
    setExporting(true);
    setExportResult(null);
    void requestDataExport({ api: runtime.api, uuid: Crypto.randomUUID }).then((result) => {
      setExportResult(result);
      setExporting(false);
    });
  };

  const confirmWord = t('rgpd.delete.confirmWord');
  const onDelete = () => {
    if (!isDeleteConfirmed(confirmText, confirmWord)) return;
    setDeleting(true);
    setDeleteResult(null);
    void deleteAccount({ ...runtime, uuid: Crypto.randomUUID }, userId).then((result) => {
      if (result.ok) {
        leave(result.cleanupFailed);
        return;
      }
      setDeleteResult(result);
      setDeleting(false);
    });
  };

  return (
    <ScrollScreen>
      <Stack.Screen options={{ headerShown: true, title: t('mobile.settings.title') }} />

      <ToggleRow
        label={t('mobile.settings.biometric.label')}
        hint={t('mobile.settings.biometric.hint')}
        value={biometric}
        busy={biometricBusy}
        onValueChange={onToggleBiometric}
      />
      {biometricRefused === null ? null : <Notice tone="error" message={t(biometricRefused)} />}

      <SectionTitle>{t('mobile.settings.rejected.title')}</SectionTitle>
      <AppText variant="muted">{t('mobile.settings.rejected.description')}</AppText>
      {rejected.length === 0 ? (
        <AppText variant="muted">{t('mobile.settings.rejected.empty')}</AppText>
      ) : null}
      {rejected.map((item) => (
        <Card key={item.id}>
          <AppText>
            {t('mobile.settings.rejected.item', {
              kind: t(item.kindKey),
              date: formatDateTime(item.failedAt, locale),
              status: item.problemCode ?? item.status,
            })}
          </AppText>
          <Button
            title={t('mobile.settings.rejected.discard')}
            accessibilityHint={t('mobile.settings.rejected.discardHint')}
            variant="secondary"
            onPress={() => {
              queue.discardDeadLetter(item.id, userId);
            }}
          />
        </Card>
      ))}

      <SectionTitle>{t('rgpd.export.title')}</SectionTitle>
      <AppText variant="muted">{t('rgpd.export.description')}</AppText>
      <Button title={t('rgpd.export.request')} busy={exporting} onPress={onExport} />
      {exportResult?.ok === true ? (
        <Notice message={t('mobile.settings.export.requested', { jobId: exportResult.jobId })} />
      ) : null}
      {exportResult?.ok === false ? <ErrorNotice error={exportResult.error} /> : null}

      <SectionTitle>{t('rgpd.delete.title')}</SectionTitle>
      <AppText variant="muted">{t('rgpd.delete.warning')}</AppText>
      <TextField
        label={t('mobile.settings.delete.inputLabel')}
        hint={t('rgpd.delete.confirmInstruction', { word: confirmWord })}
        value={confirmText}
        autoCapitalize="characters"
        onChangeText={setConfirmText}
        editable={!deleting}
      />
      {deleteResult?.ok === false ? <ErrorNotice error={deleteResult.error} /> : null}
      <Button
        title={t('rgpd.delete.confirmButton')}
        busy={deleting}
        disabled={!isDeleteConfirmed(confirmText, confirmWord)}
        onPress={onDelete}
      />

      <Button
        title={t('mobile.settings.signOut')}
        accessibilityHint={t('mobile.settings.signOutHint')}
        variant="secondary"
        busy={signingOut}
        onPress={onSignOut}
      />
    </ScrollScreen>
  );
}

export default function SettingsScreen() {
  return <SignedIn>{(userId) => <Settings userId={userId} />}</SignedIn>;
}
