/**
 * Browser clocks of the planning views: whether the viewport is wide
 * enough for the week grid, and today's local day key. Both read
 * `null`-safe values during server rendering so hydration never mismatches.
 */
import { useSyncExternalStore } from 'react';

import { toDayKey } from './planning-grid';

const WIDE_QUERY = '(min-width: 48rem)';

function subscribeToWide(onStoreChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

/** Whether the viewport reaches the `md` breakpoint; wide during server rendering. */
export function useIsWide(): boolean {
  return useSyncExternalStore(
    subscribeToWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

/** Notifies once per local midnight so the today marker follows the date. */
function subscribeToDay(onStoreChange: () => void): () => void {
  let timer: number | undefined;
  const schedule = (): void => {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    timer = window.setTimeout(
      () => {
        onStoreChange();
        schedule();
      },
      Math.max(1, nextMidnight.getTime() - now.getTime()),
    );
  };
  schedule();
  return () => window.clearTimeout(timer);
}

/** Today's local day key, `null` during server rendering and hydration. */
export function useTodayKey(): string | null {
  return useSyncExternalStore(
    subscribeToDay,
    () => toDayKey(new Date()),
    () => null,
  );
}
