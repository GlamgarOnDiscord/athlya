/**
 * Composition root: wires the device adapters (MMKV, SecureStore,
 * LocalAuthentication, NetInfo, expo-crypto) into the platform-free
 * infrastructure modules. Everything below this file is testable in Node.
 */
import { createTranslator, type Locale, type TranslationKeys } from '@athlya/shared/i18n';
import * as Crypto from 'expo-crypto';

import { createApiClient, type ApiClient } from './api/client';
import { createExpoBiometricAuthenticator } from './auth/expo-biometrics';
import { createExpoSecureStorage } from './auth/expo-secure-storage';
import { createSessionRefresher } from './auth/session';
import { TokenStore } from './auth/token-store';
import { resolveApiBaseUrl, resolveLocale } from './config';
import { createMmkvKeyValueStore } from './storage/mmkv-store';
import { loadOrCreateStorageKey, toHex } from './storage/storage-key';
import { createNetInfoConnectivity } from './sync/netinfo-connectivity';
import { MutationQueue } from './sync/queue';
import { SyncController } from './sync/sync-controller';

export interface AppRuntime {
  readonly locale: Locale;
  readonly t: (key: TranslationKeys, values?: Record<string, string | number>) => string;
  readonly api: ApiClient;
  readonly tokenStore: TokenStore;
  readonly queue: MutationQueue;
  readonly sync: SyncController;
}

export async function createAppRuntime(): Promise<AppRuntime> {
  const locale = resolveLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  const t = createTranslator(locale);
  const secure = createExpoSecureStorage();
  const encryptionKey = await loadOrCreateStorageKey(secure, () =>
    toHex(Crypto.getRandomBytes(16)),
  );
  const queue = new MutationQueue(createMmkvKeyValueStore('athlya.offline', encryptionKey), {
    uuid: Crypto.randomUUID,
  });
  const tokenStore = new TokenStore(secure, createExpoBiometricAuthenticator(), {
    unlockPrompt: t('mobile.unlock.prompt'),
  });
  const baseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_URL);
  const api = createApiClient({
    baseUrl,
    tokens: tokenStore,
    refreshAccessToken: createSessionRefresher({ baseUrl, tokenStore }),
  });
  const sync = new SyncController({ queue, api, connectivity: createNetInfoConnectivity() });
  return { locale, t, api, tokenStore, queue, sync };
}
