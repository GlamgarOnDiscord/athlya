import * as LocalAuthentication from 'expo-local-authentication';

import type { BiometricAuthenticator } from './ports';

/** `expo-local-authentication` adapter (Face ID, Touch ID, Android biometrics). */
export function createExpoBiometricAuthenticator(): BiometricAuthenticator {
  return {
    isAvailable: async () =>
      (await LocalAuthentication.hasHardwareAsync()) &&
      (await LocalAuthentication.isEnrolledAsync()),
    authenticate: async (promptMessage) => {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage });
      return result.success;
    },
  };
}
