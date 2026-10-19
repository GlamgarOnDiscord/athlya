/**
 * Device attestation port (issue #686). Sign-in and registration only see
 * this interface, so they run in Node tests against a fake;
 * `native-attestation.ts` adapts Play Integrity (Android) and DeviceCheck
 * (iOS) on device.
 */

export type AttestationPlatform = 'android' | 'ios';

export interface DeviceAttestationProvider {
  readonly platform: AttestationPlatform;
  /**
   * Starts the slow one-time setup (the Play Integrity token provider) in
   * the background, so the first sign-in does not pay for it. Never throws.
   */
  readonly warmUp: () => void;
  /**
   * A token for one sign-in or registration request. Play Integrity binds
   * it to `requestHash`; a DeviceCheck token carries no request data and
   * ignores it. Rejects when the device cannot attest.
   */
  readonly requestToken: (requestHash: string) => Promise<string>;
}
