import '../global.css';

import { t } from '@athlya/shared/i18n';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { RuntimeProvider } from '../components/RuntimeProvider';
import { AppText } from '../components/ui/AppText';
import { Screen } from '../components/ui/Screen';
import { resolveLocale } from '../infrastructure/config';
import { createAppRuntime, type AppRuntime } from '../infrastructure/runtime';

void SplashScreen.preventAutoHideAsync();

type BootState = { readonly kind: 'loading' } | { readonly kind: 'failed' } | AppRuntime;

export default function RootLayout() {
  const [boot, setBoot] = useState<BootState>({ kind: 'loading' });

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    createAppRuntime()
      .then((runtime) => {
        if (cancelled) return;
        stop = runtime.sync.start();
        setBoot(runtime);
      })
      .catch(() => {
        if (!cancelled) setBoot({ kind: 'failed' });
      })
      .finally(() => {
        void SplashScreen.hideAsync();
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  if ('kind' in boot) {
    if (boot.kind === 'loading') return null;
    const locale = resolveLocale(Intl.DateTimeFormat().resolvedOptions().locale);
    return (
      <Screen>
        <AppText>{t('errors.generic', locale)}</AppText>
      </Screen>
    );
  }

  return (
    <RuntimeProvider runtime={boot}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </RuntimeProvider>
  );
}
