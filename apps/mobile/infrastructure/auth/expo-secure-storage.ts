import * as SecureStore from 'expo-secure-store';

import type { SecureStorage } from './ports';

/**
 * `expo-secure-store` adapter: Keychain on iOS, Android Keystore-encrypted
 * values on Android. On iOS the items are readable only while the device is
 * unlocked and never migrate to another device (`keychainAccessible` is
 * iOS-only); on Android the Keystore key never leaves the device and
 * `allowBackup: false` keeps the values out of backups. The biometric gate
 * on top is enforced by `TokenStore` on both platforms.
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
