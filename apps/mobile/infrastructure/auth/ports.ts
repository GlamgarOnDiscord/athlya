/**
 * Native capabilities the auth layer depends on. The device adapters live
 * in `expo-secure-storage.ts` and `expo-biometrics.ts`; tests use fakes.
 */

/** Keychain (iOS) / Keystore-backed (Android) string storage. */
export interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/** Face ID, Touch ID or Android biometrics (with the device passcode as fallback). */
export interface BiometricAuthenticator {
  /** Hardware present and at least one biometric enrolled. */
  isAvailable(): Promise<boolean>;
  /** Shows the system prompt; resolves `true` only on a successful match. */
  authenticate(promptMessage: string): Promise<boolean>;
}
