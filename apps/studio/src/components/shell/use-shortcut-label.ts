import { useSyncExternalStore } from 'react';

const noop = (): (() => void) => () => undefined;

/** "⌘ K" on Apple devices, "Ctrl K" elsewhere and during server rendering. */
export function useShortcutLabel(key: string): string {
  const apple = useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/u.test(navigator.userAgent),
    () => false,
  );
  return `${apple ? '⌘' : 'Ctrl'} ${key}`;
}
