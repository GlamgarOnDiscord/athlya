/**
 * The current minute since the epoch, `null` during server rendering and
 * hydration so a server-rendered time never mismatches the browser's.
 * Polled every 15 s, so a minute boundary shows within that delay.
 */
import { useSyncExternalStore } from 'react';

const subscribeToMinute = (onStoreChange: () => void): (() => void) => {
  const timer = window.setInterval(onStoreChange, 15_000);
  return () => window.clearInterval(timer);
};

export function useNowMinute(): number | null {
  return useSyncExternalStore(
    subscribeToMinute,
    () => Math.floor(Date.now() / 60_000),
    () => null,
  );
}
