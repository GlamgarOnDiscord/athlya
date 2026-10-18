import * as Crypto from 'expo-crypto';
import { Redirect } from 'expo-router';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { SessionStore, type SessionState } from '../features/auth/session-store';

import { useRuntime } from './RuntimeProvider';

import type { WriteDeps } from '../features/writes';
import type { DeadLetter, MutationQueue, PendingMutation } from '../infrastructure/sync/queue';

const SessionContext = createContext<SessionStore | null>(null);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useRuntime();
  const store = useMemo(() => new SessionStore(runtime.tokenStore), [runtime]);
  useEffect(() => {
    void store.refresh();
  }, [store]);
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (store === null) throw new Error('useSessionStore must be used inside <SessionProvider>');
  return store;
}

export function useSession(): SessionState {
  const store = useSessionStore();
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Renders its children for a signed-in user and sends anyone else to `/login`. */
export function SignedIn({ children }: { readonly children: (userId: string) => ReactNode }) {
  const session = useSession();
  if (session.status === 'loading') return null;
  if (session.status === 'signed-out') return <Redirect href="/login" />;
  return <>{children(session.userId)}</>;
}

/** Dependencies of `submitWrite`, bound to the app runtime. */
export function useWriteDeps(): WriteDeps {
  const runtime = useRuntime();
  return useMemo(
    () => ({
      api: runtime.api,
      queue: runtime.queue,
      sync: runtime.sync,
      getOwnerId: () => runtime.tokenStore.getUserId(),
      uuid: Crypto.randomUUID,
    }),
    [runtime],
  );
}

function useQueueSnapshot<T>(
  ownerId: string,
  read: (queue: MutationQueue, ownerId: string) => T,
): T {
  const { queue } = useRuntime();
  const [value, setValue] = useState(() => read(queue, ownerId));
  useEffect(() => {
    const update = (): void => {
      setValue(read(queue, ownerId));
    };
    update();
    return queue.subscribe(update);
  }, [queue, ownerId, read]);
  return value;
}

const readPending = (queue: MutationQueue, ownerId: string): readonly PendingMutation[] =>
  queue.pendingFor(ownerId);

const readDeadLetters = (queue: MutationQueue, ownerId: string): readonly DeadLetter[] =>
  queue.deadLetters(ownerId);

/** The user's queued mutations, updated on every queue change. */
export function usePendingMutations(ownerId: string): readonly PendingMutation[] {
  return useQueueSnapshot(ownerId, readPending);
}

/** The user's rejected (dead-lettered) mutations, updated on every queue change. */
export function useDeadLetters(ownerId: string): readonly DeadLetter[] {
  return useQueueSnapshot(ownerId, readDeadLetters);
}
