import { useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';

import { syncBannerModel } from './ui/a11y';

import type { AppRuntime } from '../infrastructure/runtime';

export interface SyncStatusBannerProps {
  readonly runtime: AppRuntime;
}

/**
 * Offline / sync progress banner (design.md edge case E8). Announced as a
 * polite live region so screen readers follow the progress.
 */
export function SyncStatusBanner({ runtime }: SyncStatusBannerProps) {
  const state = useSyncExternalStore(
    (listener) => runtime.sync.subscribe(listener),
    () => runtime.sync.getState(),
  );
  const model = syncBannerModel(state);
  if (model === null) return null;
  const message = runtime.t(model.message.key, model.message.values);
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
