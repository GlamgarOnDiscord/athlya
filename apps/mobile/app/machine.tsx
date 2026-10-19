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
import { usableHeartRate } from '../features/ftms/heart-rate';
import {
  HeartRateController,
  linkStrapToMachine,
  type StrapError,
} from '../features/ftms/heart-rate-controller';
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

const STRAP_ERROR_KEYS: Readonly<Record<StrapError, TranslationKeys>> = {
  scanFailed: 'mobile.machine.strap.errors.scanFailed',
  connectFailed: 'mobile.machine.strap.errors.connectFailed',
  notHeartRate: 'mobile.machine.strap.errors.notHeartRate',
  linkLost: 'mobile.machine.strap.errors.linkLost',
};

/**
 * Heart-rate strap pairing (issue #669), on its own Bluetooth connection:
 * it works with or without a machine, and losing it never stops the
 * machine session. A BLE radio runs one scan at a time, so starting this
 * scan stops the machine's, and the other way round.
 */
function StrapCard({
  strap,
  onBeforeScan,
}: {
  readonly strap: HeartRateController;
  readonly onBeforeScan: () => void;
}) {
  const { t } = useRuntime();
  const state = useSyncExternalStore(strap.subscribe, strap.get);
  const name = (device: { readonly name: string | null }) =>
    device.name ?? t('mobile.machine.strap.unnamed');
  const idle = state.status === 'idle' || state.status === 'unavailable';
  const bpm = state.reading === null ? null : usableHeartRate(state.reading);

  return (
    <Card>
      <Text
        accessibilityRole="header"
        className="text-base font-semibold text-foreground dark:text-dark-foreground"
      >
        {t('mobile.machine.strap.title')}
      </Text>
      <AppText variant="muted">{t('mobile.machine.strap.intro')}</AppText>

      {state.status === 'unavailable' && state.readiness !== null ? (
        <Notice tone="error" message={t(`mobile.machine.unavailable.${state.readiness}`)} />
      ) : null}
      {state.error === null ? null : (
        <Notice
          tone={state.error === 'linkLost' ? 'info' : 'error'}
          message={t(STRAP_ERROR_KEYS[state.error])}
        />
      )}
      {state.nothingFound ? <Notice message={t('mobile.machine.strap.nothingFound')} /> : null}

      {idle || state.status === 'preparing' ? (
        <View className="gap-sm">
          <Button
            title={t('mobile.machine.strap.scan')}
            variant="secondary"
            busy={state.status === 'preparing'}
            onPress={() => {
              onBeforeScan();
              void strap.scan();
            }}
          />
          {state.remembered !== null && idle ? (
            <>
              <Button
                title={t('mobile.machine.strap.reconnect', { name: name(state.remembered) })}
                variant="secondary"
                onPress={() => {
                  onBeforeScan();
                  void strap.reconnect();
                }}
              />
              <Button
                title={t('mobile.machine.strap.forget')}
                variant="secondary"
                onPress={() => {
                  strap.forget();
                }}
              />
            </>
          ) : null}
        </View>
      ) : null}

      {state.status === 'scanning' ? (
        <View className="gap-sm">
          <Notice message={t('mobile.machine.strap.scanning')} />
          <Button
            title={t('mobile.machine.stopScan')}
            variant="secondary"
            onPress={() => {
              strap.stopScan();
            }}
          />
        </View>
      ) : null}

      {state.devices.length > 0 && (state.status === 'scanning' || state.status === 'idle') ? (
        <View className="gap-sm">
          <AppText variant="muted">{t('mobile.machine.strap.devices')}</AppText>
          {state.devices.map((device) => (
            <Button
              key={device.id}
              variant="secondary"
              title={t('mobile.machine.connectTo', { name: name(device) })}
              onPress={() => {
                void strap.connect(device.id);
              }}
            />
          ))}
        </View>
      ) : null}

      {state.status === 'connecting' && state.device !== null ? (
        <Notice message={t('mobile.machine.strap.connecting', { name: name(state.device) })} />
      ) : null}

      {state.status === 'connected' && state.device !== null ? (
        <View className="gap-sm">
          <Notice message={t('mobile.machine.strap.connected', { name: name(state.device) })} />
          {state.reading === null ? (
            <AppText variant="muted">{t('mobile.machine.strap.waiting')}</AppText>
          ) : null}
          {state.reading?.contact === 'notDetected' ? (
            <Notice tone="error" message={t('mobile.machine.strap.noContact')} />
          ) : null}
          {bpm === null ? null : (
            <View
              accessible
              accessibilityLabel={`${t('mobile.machine.metrics.heartRate')}, ${t('mobile.machine.metrics.unit.bpm', { value: bpm })}`}
              className="flex-row justify-between"
            >
              <AppText variant="muted">{t('mobile.machine.metrics.heartRate')}</AppText>
              <AppText>{t('mobile.machine.metrics.unit.bpm', { value: bpm })}</AppText>
            </View>
          )}
          <Button
            title={t('mobile.machine.strap.disconnect')}
            variant="secondary"
            onPress={() => {
              strap.disconnect();
            }}
          />
        </View>
      ) : null}
    </Card>
  );
}

/**
 * Connected machine (task 23.1): finds Bluetooth FTMS machines, streams
 * their live data and logs the session as a workout. The BLE manager is
 * only created here, so the Bluetooth prompt never shows elsewhere.
 */
function Machine() {
  const runtime = useRuntime();
  const { t, locale } = runtime;
  const writes = useWriteDeps();
  const transport = useMemo(() => createBlePlxTransport(), []);
  const controller = useMemo(() => new FtmsController({ transport }), [transport]);
  const strap = useMemo(
    () => new HeartRateController({ transport, preferences: runtime.preferences }),
    [transport, runtime.preferences],
  );
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

  useEffect(() => {
    const unlink = linkStrapToMachine(strap, controller);
    return () => {
      unlink();
      strap.dispose();
    };
  }, [strap, controller]);

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
            strap.stopScan();
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

      <StrapCard
        strap={strap}
        onBeforeScan={() => {
          controller.stopScan();
        }}
      />

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
