/**
 * Device attestation headers for sign-in and registration (issue #686).
 *
 * The API reads `x-device-attestation-platform` and
 * `x-device-attestation-token` next to `cf-turnstile-token` as an extra
 * signal (`docs/runbooks/device-attestation.md`). Android binds its Play
 * Integrity token to the request: the `requestHash` is
 * base64url_nopad(SHA-256(`athlya-auth-v1:<action>:<turnstile token>`)),
 * the same value as the API's `computeAttestationRequestHash`.
 *
 * Best effort: any failure (no provider, native error, a token that is
 * empty, too long or not header-safe, or no answer within
 * {@link ATTESTATION_TIMEOUT_MS}) yields no headers, and the request goes
 * out without them. Attestation never blocks a sign-in.
 */
import { bytesToBase64 } from '../../infrastructure/ble/base64';

import type { DeviceAttestationProvider } from '../../infrastructure/attestation/ports';

export const ATTESTATION_PLATFORM_HEADER = 'x-device-attestation-platform';

export const ATTESTATION_TOKEN_HEADER = 'x-device-attestation-token';

export const ATTESTATION_REQUEST_HASH_PREFIX = 'athlya-auth-v1';

/** Longest token the API accepts. */
export const MAX_ATTESTATION_TOKEN_LENGTH = 16_384;

/** How long sign-in waits for the device before sending the request without attestation. */
export const ATTESTATION_TIMEOUT_MS = 2_000;

/** Play Integrity tokens are JWE compact strings, DeviceCheck tokens base64. */
const HEADER_SAFE_TOKEN = /^[A-Za-z0-9+/=._-]+$/u;

export type AttestationAction = 'login' | 'register';

export interface AttestationDeps {
  readonly provider: DeviceAttestationProvider | null;
  readonly sha256: (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;
}

export async function computeAttestationRequestHash(
  sha256: AttestationDeps['sha256'],
  action: AttestationAction,
  turnstileToken: string,
): Promise<string> {
  const input = `${ATTESTATION_REQUEST_HASH_PREFIX}:${action}:${turnstileToken.trim()}`;
  const digest = await sha256(new TextEncoder().encode(input));
  return bytesToBase64(digest).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Lets the provider get ready while the member fills in the form. */
export function warmUpAttestation(deps: AttestationDeps | undefined): void {
  try {
    deps?.provider?.warmUp();
  } catch {
    // Retried by the next request.
  }
}

export async function attestationHeaders(
  deps: AttestationDeps | undefined,
  action: AttestationAction,
  turnstileToken: string,
): Promise<Readonly<Record<string, string>>> {
  const provider = deps?.provider ?? null;
  if (deps === undefined || provider === null) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ATTESTATION_TIMEOUT_MS);
  });
  const attest = async (): Promise<string> =>
    provider.requestToken(await computeAttestationRequestHash(deps.sha256, action, turnstileToken));
  try {
    const token = await Promise.race([attest(), timeout]);
    if (
      typeof token !== 'string' ||
      token.length > MAX_ATTESTATION_TOKEN_LENGTH ||
      !HEADER_SAFE_TOKEN.test(token)
    ) {
      return {};
    }
    return { [ATTESTATION_PLATFORM_HEADER]: provider.platform, [ATTESTATION_TOKEN_HEADER]: token };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
