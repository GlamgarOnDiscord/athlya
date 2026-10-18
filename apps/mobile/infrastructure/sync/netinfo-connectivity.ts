import NetInfo from '@react-native-community/netinfo';

import { isOnlineState, type ConnectivitySource } from './sync-controller';

/** `@react-native-community/netinfo` adapter; `dispose()` removes the native listener. */
export function createNetInfoConnectivity(): ConnectivitySource & { dispose(): void } {
  let online = false;
  const listeners = new Set<(online: boolean) => void>();
  const unsubscribe = NetInfo.addEventListener((state) => {
    const next = isOnlineState(state);
    if (next === online) return;
    online = next;
    for (const listener of listeners) listener(online);
  });
  return {
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      unsubscribe();
      listeners.clear();
    },
  };
}
