import { colors } from '@athlya/shared/tokens';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppState, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { SignedIn } from '../components/AppSession';
import { ErrorNotice } from '../components/ErrorNotice';
import { useRuntime } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Button } from '../components/ui/Button';
import { Notice } from '../components/ui/Notice';
import { ScrollScreen } from '../components/ui/ScrollScreen';
import { CheckinTokenController } from '../features/checkin/checkin-token';

const QR_SIZE = 240;

/**
 * QR check-in (task 11.9): shows the member's single-use check-in code,
 * renewed before it expires, for staff to scan at the front desk. Codes
 * are fetched only while the screen is focused and the app is in the
 * foreground; nothing is ever queued offline.
 */
function Checkin() {
  const runtime = useRuntime();
  const { t } = runtime;
  const controller = useMemo(
    () =>
      new CheckinTokenController({
        api: runtime.api,
        isOnline: () => runtime.sync.getState().status !== 'offline',
      }),
    [runtime],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const focused = useRef(false);

  useEffect(
    () =>
      runtime.sync.subscribe(() => {
        controller.setOnline(runtime.sync.getState().status !== 'offline');
      }),
    [runtime, controller],
  );

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (AppState.currentState === 'active') controller.start();
      const subscription = AppState.addEventListener('change', (next) => {
        if (next === 'active' && focused.current) controller.start();
        else controller.stop();
      });
      return () => {
        focused.current = false;
        subscription.remove();
        controller.stop();
      };
    }, [controller]),
  );

  return (
    <ScrollScreen>
      <AppText variant="title">{t('mobile.checkin.title')}</AppText>
      <AppText variant="muted">{t('mobile.checkin.intro')}</AppText>
      {state.status === 'offline' ? <Notice message={t('mobile.checkin.offline')} /> : null}
      {state.token === null ? null : (
        <View className="items-center gap-sm">
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('mobile.checkin.qrLabel', { seconds: state.secondsLeft })}
            // Dark modules on a light quiet zone in both themes: scanners
            // expect that contrast.
            className="rounded-md p-md"
            style={{ backgroundColor: colors.light.background }}
          >
            <QRCode
              value={state.token}
              size={QR_SIZE}
              color={colors.light.foreground}
              backgroundColor={colors.light.background}
              ecl="M"
            />
          </View>
          <AppText variant="muted">
            {t('mobile.checkin.expiresIn', { seconds: state.secondsLeft })}
          </AppText>
        </View>
      )}
      {state.status === 'loading' && state.token === null ? (
        <AppText variant="muted">{t('mobile.checkin.loading')}</AppText>
      ) : null}
      {state.error === null ? null : (
        <View className="gap-sm">
          {state.token === null ? (
            <AppText variant="muted">{t('mobile.checkin.loadError')}</AppText>
          ) : null}
          <ErrorNotice error={state.error} />
          {state.error.authRequired ? null : (
            <Button
              title={t('mobile.checkin.newCode')}
              variant="secondary"
              onPress={() => {
                controller.retry();
              }}
            />
          )}
        </View>
      )}
    </ScrollScreen>
  );
}

export default function CheckinScreen() {
  return <SignedIn>{() => <Checkin />}</SignedIn>;
}
