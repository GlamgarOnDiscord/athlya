import * as SecureStore from 'expo-secure-store';

import type { SecureStorage } from './ports';

/**
 * `expo-secure-store` adapter: Keychain on iOS, Keystore-encrypted
 * storage on Android. Items are readable only while the device is
 * unlocked and never migrate to another device through backups.
 */
export function createExpoSecureStorage(): SecureStorage {
  const options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  return {
    getItem: (key) => SecureStore.getItemAsync(key, options),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, options),
    deleteItem: (key) => SecureStore.deleteItemAsync(key, options),
  };
}
