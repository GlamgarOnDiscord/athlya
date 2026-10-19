/**
 * Native adapters for the {@link DeviceAttestationProvider} port.
 *
 * Android uses Play Integrity standard requests through
 * `@expo/app-integrity`. The token provider is prepared once per process
 * with the Cloud project number linked in Play Console
 * (`EXPO_PUBLIC_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER`); a failed preparation
 * or request drops it, so the next attempt prepares a new one.
 *
 * iOS uses DeviceCheck (`DCDevice.generateToken`) through the local
 * `AthlyaDeviceCheck` module (`modules/device-check`): `@expo/app-integrity`
 * only exposes App Attest there, which the API does not verify.
 *
 * `@expo/app-integrity` is loaded lazily and the iOS module is optional, so
 * a build without them, or a device that cannot attest, has no provider and
 * signs in without attestation.
 */
import { requireOptionalNativeModule } from 'expo';

import type { DeviceAttestationProvider } from './ports';
import type * as AppIntegrity from '@expo/app-integrity';

interface DeviceCheckModule {
  readonly isSupported: boolean;
  /** Base64 of the `DCDevice` token. */
  generateTokenAsync(): Promise<string>;
}

const CLOUD_PROJECT_NUMBER = /^\d{1,20}$/u;

export function createPlayIntegrityProvider(
  cloudProjectNumber: string | undefined,
): DeviceAttestationProvider | null {
  const projectNumber = cloudProjectNumber?.trim() ?? '';
  if (!CLOUD_PROJECT_NUMBER.test(projectNumber)) return null;

  let prepared: Promise<typeof AppIntegrity> | null = null;
  const prepare = (): Promise<typeof AppIntegrity> => {
    if (prepared === null) {
      const attempt = import('@expo/app-integrity').then(async (integrity) => {
        await integrity.prepareIntegrityTokenProviderAsync(projectNumber);
        return integrity;
      });
      prepared = attempt;
      void attempt.catch(() => {
        if (prepared === attempt) prepared = null;
      });
    }
    return prepared;
  };

  return {
    platform: 'android',
    warmUp: () => {
      void prepare().catch(() => undefined);
    },
    requestToken: async (requestHash) => {
      const attempt = prepare();
      try {
        const integrity = await attempt;
        return await integrity.requestIntegrityCheckAsync(requestHash);
      } catch (error) {
        // The provider can expire or be invalidated by Play: start over next time.
        if (prepared === attempt) prepared = null;
        throw error;
      }
    },
  };
}

export function createDeviceCheckProvider(): DeviceAttestationProvider | null {
  let native: DeviceCheckModule | null;
  try {
    native = requireOptionalNativeModule<DeviceCheckModule>('AthlyaDeviceCheck');
  } catch {
    return null;
  }
  if (native?.isSupported !== true) return null;
  const deviceCheck = native;
  return {
    platform: 'ios',
    warmUp: () => undefined,
    requestToken: () => deviceCheck.generateTokenAsync(),
  };
}

export interface NativeAttestationOptions {
  /** `Platform.OS`. */
  readonly os: string;
  readonly cloudProjectNumber: string | undefined;
}

export function createNativeAttestationProvider(
  options: NativeAttestationOptions,
): DeviceAttestationProvider | null {
  switch (options.os) {
    case 'android':
      return createPlayIntegrityProvider(options.cloudProjectNumber);
    case 'ios':
      return createDeviceCheckProvider();
    default:
      return null;
  }
}
