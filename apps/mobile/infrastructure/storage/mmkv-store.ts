import { createMMKV } from 'react-native-mmkv';

import type { KeyValueStore } from './key-value-store';

/**
 * MMKV-backed {@link KeyValueStore}. The file is encrypted with AES-256
 * using a per-install key kept in the platform keystore (see
 * `infrastructure/runtime.ts`), because queued mutations can carry
 * workout data.
 */
export function createMmkvKeyValueStore(id: string, encryptionKey: string): KeyValueStore {
  const mmkv = createMMKV({ id, encryptionKey, encryptionType: 'AES-256' });
  return {
    getString: (key) => mmkv.getString(key),
    set: (key, value) => {
      mmkv.set(key, value);
    },
    remove: (key) => {
      mmkv.remove(key);
    },
  };
}
