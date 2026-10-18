/**
 * Synchronous string key-value storage — the slice of MMKV the offline
 * layer depends on. Keeping it behind this interface lets the queue and
 * its tests run in Node, where the native MMKV module does not exist.
 */
export interface KeyValueStore {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * In-memory implementation. Passing the same `backing` map to two stores
 * simulates a process restart over the same on-disk MMKV file.
 */
export function createMemoryKeyValueStore(
  backing: Map<string, string> = new Map<string, string>(),
): KeyValueStore {
  return {
    getString: (key) => backing.get(key),
    set: (key, value) => {
      backing.set(key, value);
    },
    remove: (key) => {
      backing.delete(key);
    },
  };
}
