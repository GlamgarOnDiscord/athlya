import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';

import { syncBannerModel } from './ui/a11y';

import type { AppRuntime } from '../infrastructure/runtime';

export interface SyncStatusBannerProps {
  readonly runtime: AppRuntime;
}

/**
 * Offline / sync progress banner (design.md edge case E8). Android
 * announces it through a polite live region; iOS has no live regions, so
 * message changes after the first render are announced explicitly.
 */
export function SyncStatusBanner({ runtime }: SyncStatusBannerProps) {
  const state = useSyncExternalStore(
    (listener) => runtime.sync.subscribe(listener),
    () => runtime.sync.getState(),
  );
  const model = syncBannerModel(state);
  const message = model === null ? null : runtime.t(model.message.key, model.message.values);
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const isFirstRender = previous.current === undefined;
    const changed = previous.current !== message;
    previous.current = message;
    if (Platform.OS === 'ios' && !isFirstRender && changed && message !== null) {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  if (model === null || message === null) return null;
  return (
    <View
      accessible
      accessibilityLabel={`${runtime.t('mobile.sync.label')}: ${message}`}
      accessibilityLiveRegion="polite"
      {...(model.progress === undefined
        ? {}
        : { accessibilityRole: 'progressbar' as const, accessibilityValue: model.progress })}
      className="rounded-md bg-muted px-md py-sm dark:bg-dark-muted"
    >
      <Text className="text-sm text-foreground dark:text-dark-foreground">{message}</Text>
    </View>
  );
}
