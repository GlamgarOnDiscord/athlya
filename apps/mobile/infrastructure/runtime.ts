/**
 * Composition root: wires the device adapters (MMKV, SecureStore,
 * LocalAuthentication, NetInfo, expo-crypto, Play Integrity, DeviceCheck)
 * into the platform-free infrastructure modules. Everything below this
 * file is testable in Node.
 */
import { createTranslator, type Locale, type TranslationKeys } from '@athlya/shared/i18n';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import { createApiClient, type ApiClient } from './api/client';
import { createNativeAttestationProvider } from './attestation/native-attestation';
import { createExpoBiometricAuthenticator } from './auth/expo-biometrics';
import { createExpoSecureStorage } from './auth/expo-secure-storage';
import { createSessionRefresher } from './auth/session';
import { TokenStore } from './auth/token-store';
import { resolveApiBaseUrl, resolveLocale } from './config';
import { createHealthKitStore } from './health/healthkit-store';
import { AppleHealthLinkStore } from './health/link-store';
import { createMmkvKeyValueStore } from './storage/mmkv-store';
import { loadOrCreateStorageKey, toHex } from './storage/storage-key';
import { createNetInfoConnectivity } from './sync/netinfo-connectivity';
import { MutationQueue } from './sync/queue';
import { SyncController } from './sync/sync-controller';

import type { HealthStore } from './health/ports';
import type { KeyValueStore } from './storage/key-value-store';
import type { AttestationDeps } from '../features/auth/attestation';

export interface AppRuntime {
  readonly locale: Locale;
  /** API origin (`EXPO_PUBLIC_API_URL`), also loaded by the Turnstile WebView. */
  readonly apiBaseUrl: string;
  readonly t: (key: TranslationKeys, values?: Record<string, string | number>) => string;
  readonly api: ApiClient;
  readonly tokenStore: TokenStore;
  readonly queue: MutationQueue;
  /** On-device preferences (e.g. the last paired heart-rate strap); never synced. */
  readonly preferences: KeyValueStore;
  readonly sync: SyncController;
  /** Apple Health (HealthKit, iOS only) and the per-user import links. */
  readonly health: HealthStore;
  readonly healthLinks: AppleHealthLinkStore;
  /** Device attestation on sign-in and registration; `provider` is null when unavailable. */
  readonly attestation: AttestationDeps;
  /** Releases native listeners (NetInfo). */
  readonly dispose: () => void;
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
  const preferences = createMmkvKeyValueStore('athlya.preferences', encryptionKey);
  const healthLinks = new AppleHealthLinkStore(preferences);
  const tokenStore = new TokenStore(secure, createExpoBiometricAuthenticator(), {
    unlockPrompt: t('mobile.unlock.prompt'),
  });
  const baseUrl = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_URL);
  const api = createApiClient({
    baseUrl,
    tokens: tokenStore,
    refreshAccessToken: createSessionRefresher({ baseUrl, tokenStore }),
  });
  const connectivity = createNetInfoConnectivity();
  const sync = new SyncController({
    queue,
    api,
    connectivity,
    getOwnerId: () => tokenStore.getUserId(),
  });
  const attestation: AttestationDeps = {
    provider: createNativeAttestationProvider({
      os: Platform.OS,
      cloudProjectNumber: process.env.EXPO_PUBLIC_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER,
    }),
    sha256: async (data) =>
      new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data)),
  };
  return {
    locale,
    apiBaseUrl: baseUrl,
    t,
    api,
    tokenStore,
    queue,
    preferences,
    sync,
    health: createHealthKitStore(),
    healthLinks,
    attestation,
    dispose: () => connectivity.dispose(),
  };
}
