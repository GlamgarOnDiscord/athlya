import { createContext, useContext, type ReactNode } from 'react';

import type { AppRuntime } from '../infrastructure/runtime';

const RuntimeContext = createContext<AppRuntime | null>(null);

export function RuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: AppRuntime;
  readonly children: ReactNode;
}) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

/** The app runtime (API client, token store, queue, sync controller). */
export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) throw new Error('useRuntime must be used inside <RuntimeProvider>');
  return runtime;
}
