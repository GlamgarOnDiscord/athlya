import { Stack } from 'expo-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';

import { SignedIn, useWriteDeps } from '../components/AppSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { FtmsController, type MachineError } from '../features/ftms/ftms-controller';
import { liveMetricRows } from '../features/ftms/live-metrics';
import {
  buildMachineSessionRequest,
  MACHINE_NAME_KEYS,
  saveMachineSession,
  type SaveMachineSessionResult,
} from '../features/ftms/machine-workout';
import { createBlePlxTransport } from '../infrastructure/ble/ble-plx-transport';

import type { TranslationKeys } from '@athlya/shared/i18n';

const ERROR_KEYS: Readonly<Record<MachineError, TranslationKeys>> = {
  scanFailed: 'mobile.machine.errors.scanFailed',
  connectFailed: 'mobile.machine.errors.connectFailed',
  notFtms: 'mobile.machine.errors.notFtms',
  linkLost: 'mobile.machine.errors.linkLost',
};

/**
 * Connected machine (task 23.1): finds Bluetooth FTMS machines, streams
 * their live data and logs the session as a workout. The BLE manager is
 * only created here, so the Bluetooth prompt never shows elsewhere.
 */
function Machine() {
  const runtime = useRuntime();
  const { t, locale } = runtime;
  const writes = useWriteDeps();
  const controller = useMemo(() => new FtmsController({ transport: createBlePlxTransport() }), []);
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveMachineSessionResult | null>(null);
  const inflight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      inflight.current?.abort();
      controller.dispose();
    },
    [controller],
  );

  // Ticks the clock for machines that do not report an elapsed time.
  useEffect(() => {
    if (state.status !== 'streaming') return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [state.status]);

  const deviceName = state.device?.name ?? t('mobile.machine.unnamed');
  const hasData = state.session !== null && state.session.samples > 0;
  const ended = state.status === 'finished' || state.status === 'disconnected';
  const canScan =
    state.status === 'idle' ||
    state.status === 'preparing' ||
    state.status === 'unavailable' ||
    (ended && !hasData);

  const save = () => {
    const summary = controller.summary();
    const request = summary === null ? null : buildMachineSessionRequest(summary, t, locale);
    const abort = new AbortController();
    inflight.current = abort;
    setSaving(true);
    setSaved(null);
    saveMachineSession(writes, request, abort.signal)
      .then((outcome) => {
        setSaved(outcome);
        if (outcome.kind === 'sent' || outcome.kind === 'queued' || outcome.kind === 'empty') {
          controller.reset();
        }
      })
      .catch(() => {
        // Cancelled because the screen went away: nothing was sent or queued.
      })
      .finally(() => {
        if (!abort.signal.aborted) setSaving(false);
      });
  };

  const rows = state.session === null ? [] : liveMetricRows(state.session, now, t, locale);

  return (
    <ScrollScreen>
      <Stack.Screen options={{ headerShown: true, title: t('mobile.machine.title') }} />
      <AppText variant="muted">{t('mobile.machine.intro')}</AppText>

      {state.status === 'unavailable' && state.readiness !== null ? (
        <Notice tone="error" message={t(`mobile.machine.unavailable.${state.readiness}`)} />
      ) : null}
      {state.error === null ? null : (
        <Notice
          tone={state.error === 'linkLost' ? 'info' : 'error'}
          message={t(ERROR_KEYS[state.error])}
        />
      )}
      {state.nothingFound ? <Notice message={t('mobile.machine.nothingFound')} /> : null}
      {saved?.kind === 'sent' ? <Notice message={t('mobile.machine.saved')} /> : null}
      {saved?.kind === 'queued' ? <Notice message={t('mobile.machine.queued')} /> : null}
      {saved?.kind === 'empty' ? <Notice message={t('mobile.machine.empty')} /> : null}
      {saved?.kind === 'error' ? <ErrorNotice error={saved.error} /> : null}

      {canScan ? (
        <Button
          title={t('mobile.machine.scan')}
          busy={state.status === 'preparing'}
          onPress={() => {
            setSaved(null);
            void controller.scan();
          }}
        />
      ) : null}

      {state.status === 'scanning' ? (
        <View className="gap-sm">
          <Notice message={t('mobile.machine.scanning')} />
          <Button
            title={t('mobile.machine.stopScan')}
            variant="secondary"
            onPress={() => {
              controller.stopScan();
            }}
          />
        </View>
      ) : null}

      {state.devices.length > 0 && (state.status === 'scanning' || state.status === 'idle') ? (
        <View className="gap-sm">
          <Text
            accessibilityRole="header"
            className="text-base font-semibold text-foreground dark:text-dark-foreground"
          >
            {t('mobile.machine.devices')}
          </Text>
          {state.devices.map((device) => (
            <Button
              key={device.id}
              variant="secondary"
              title={t('mobile.machine.connectTo', {
                name: device.name ?? t('mobile.machine.unnamed'),
              })}
              onPress={() => {
                void controller.connect(device.id);
              }}
            />
          ))}
        </View>
      ) : null}

      {state.status === 'connecting' ? (
        <Notice message={t('mobile.machine.connecting', { name: deviceName })} />
      ) : null}
      {state.status === 'streaming' ? (
        <Notice message={t('mobile.machine.streaming', { name: deviceName })} />
      ) : null}

      {state.session === null ? null : (
        <Card>
          <Text
            accessibilityRole="header"
            className="text-base font-semibold text-foreground dark:text-dark-foreground"
          >
            {`${t(MACHINE_NAME_KEYS[state.session.machine])} · ${t('mobile.machine.metrics.label')}`}
          </Text>
          {rows.map((row) => (
            // One element per metric so a screen reader reads "Power, 182 W"
            // without the value being announced on every notification.
            <View
              key={row.key}
              accessible
              accessibilityLabel={`${row.label}, ${row.value}`}
              className="flex-row justify-between"
            >
              <AppText variant="muted">{row.label}</AppText>
              <AppText>{row.value}</AppText>
            </View>
          ))}
        </Card>
      )}

      {state.status === 'streaming' ? (
        <Button
          title={t('mobile.machine.finish')}
          onPress={() => {
            controller.finish();
          }}
        />
      ) : null}

      {ended && hasData ? (
        <View className="gap-sm">
          <Button title={t('mobile.machine.save')} busy={saving} onPress={save} />
          <Button
            title={t('mobile.machine.discard')}
            variant="secondary"
            disabled={saving}
            onPress={() => {
              setSaved(null);
              controller.reset();
            }}
          />
        </View>
      ) : null}
    </ScrollScreen>
  );
}

export default function MachineScreen() {
  return <SignedIn>{() => <Machine />}</SignedIn>;
}
