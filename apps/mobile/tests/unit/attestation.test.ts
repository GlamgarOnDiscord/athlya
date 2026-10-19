import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTESTATION_PLATFORM_HEADER,
  ATTESTATION_TIMEOUT_MS,
  ATTESTATION_TOKEN_HEADER,
  MAX_ATTESTATION_TOKEN_LENGTH,
  attestationHeaders,
  computeAttestationRequestHash,
  warmUpAttestation,
  type AttestationDeps,
} from '../../features/auth/attestation';

import type { DeviceAttestationProvider } from '../../infrastructure/attestation/ports';

const sha256: AttestationDeps['sha256'] = (data) =>
  Promise.resolve(new Uint8Array(createHash('sha256').update(data).digest()));

const INTEGRITY_TOKEN = ['header', 'key', 'iv', 'payload', 'tag'].join('.');

function provider(
  overrides: Partial<DeviceAttestationProvider> = {},
): DeviceAttestationProvider & { requestToken: ReturnType<typeof vi.fn> } {
  return {
    platform: 'android',
    warmUp: vi.fn(),
    requestToken: vi.fn(() => Promise.resolve(INTEGRITY_TOKEN)),
    ...overrides,
  } as DeviceAttestationProvider & { requestToken: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('computeAttestationRequestHash', () => {
  // Vectors computed with the API's computeAttestationRequestHash
  // (packages/api/src/middleware/device-attestation.ts).
  it.each([
    ['login', 'turnstile-0000', 'D1PSGm8sQpi4NV48vAmQ17aiAKxQFzjXWdBemeWmyaA'],
    ['register', 'turnstile-0000', 'WQzYhej9AWGtcXbpKmM96HNdtZ521g-znBAiNfBY_lY'],
    ['login', '  XXXX.dummy-token_1  ', 'OKQkPCWVW9nvQNvZYnnkHxl7r-wg5LYKorcgWnW1qk8'],
  ] as const)('matches the server for %s / %j', async (action, turnstile, expected) => {
    await expect(computeAttestationRequestHash(sha256, action, turnstile)).resolves.toBe(expected);
  });

  it('is base64url of SHA-256("athlya-auth-v1:<action>:<token>") without padding', async () => {
    const turnstile = 'a+b/c=d';
    const expected = createHash('sha256')
      .update(`athlya-auth-v1:register:${turnstile}`)
      .digest('base64url');
    const hash = await computeAttestationRequestHash(sha256, 'register', turnstile);
    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe('attestationHeaders', () => {
  it('returns the platform and token headers on success', async () => {
    const native = provider();
    const headers = await attestationHeaders({ provider: native, sha256 }, 'login', 'ts-1');
    expect(headers).toEqual({
      [ATTESTATION_PLATFORM_HEADER]: 'android',
      [ATTESTATION_TOKEN_HEADER]: INTEGRITY_TOKEN,
    });
    expect(native.requestToken).toHaveBeenCalledWith(
      createHash('sha256').update('athlya-auth-v1:login:ts-1').digest('base64url'),
    );
  });

  it('labels iOS tokens with the ios platform', async () => {
    const native = provider({
      platform: 'ios',
      requestToken: vi.fn(() => Promise.resolve('AAAA+bbbb/cccc==')),
    });
    await expect(
      attestationHeaders({ provider: native, sha256 }, 'register', 'ts-1'),
    ).resolves.toEqual({
      [ATTESTATION_PLATFORM_HEADER]: 'ios',
      [ATTESTATION_TOKEN_HEADER]: 'AAAA+bbbb/cccc==',
    });
  });

  it('returns no headers without deps or provider (unsupported device, missing config)', async () => {
    await expect(attestationHeaders(undefined, 'login', 'ts-1')).resolves.toEqual({});
    await expect(attestationHeaders({ provider: null, sha256 }, 'login', 'ts-1')).resolves.toEqual(
      {},
    );
  });

  it('returns no headers when the native call rejects or throws', async () => {
    const rejecting = provider({
      requestToken: vi.fn(() => Promise.reject(new Error('play services missing'))),
    });
    const throwing = provider({
      requestToken: vi.fn(() => {
        throw new Error('module missing');
      }),
    });
    await expect(
      attestationHeaders({ provider: rejecting, sha256 }, 'login', 'ts-1'),
    ).resolves.toEqual({});
    await expect(
      attestationHeaders({ provider: throwing, sha256 }, 'login', 'ts-1'),
    ).resolves.toEqual({});
  });

  it('returns no headers when hashing fails', async () => {
    const failingHash: AttestationDeps['sha256'] = () => Promise.reject(new Error('no digest'));
    await expect(
      attestationHeaders({ provider: provider(), sha256: failingHash }, 'login', 'ts-1'),
    ).resolves.toEqual({});
  });

  it('drops an oversized, empty or header-unsafe token', async () => {
    for (const token of ['a'.repeat(MAX_ATTESTATION_TOKEN_LENGTH + 1), '', 'bad token\n']) {
      const native = provider({ requestToken: vi.fn(() => Promise.resolve(token)) });
      await expect(
        attestationHeaders({ provider: native, sha256 }, 'login', 'ts-1'),
      ).resolves.toEqual({});
    }
    const longest = 'a'.repeat(MAX_ATTESTATION_TOKEN_LENGTH);
    const native = provider({ requestToken: vi.fn(() => Promise.resolve(longest)) });
    await expect(
      attestationHeaders({ provider: native, sha256 }, 'login', 'ts-1'),
    ).resolves.toMatchObject({ [ATTESTATION_TOKEN_HEADER]: longest });
  });

  it('gives up after the timeout and sends no headers', async () => {
    vi.useFakeTimers();
    const native = provider({ requestToken: vi.fn(() => new Promise<string>(() => undefined)) });
    const pending = attestationHeaders({ provider: native, sha256 }, 'login', 'ts-1');
    await vi.advanceTimersByTimeAsync(ATTESTATION_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({});
  });

  it('ignores a token that arrives after the timeout', async () => {
    vi.useFakeTimers();
    let resolveToken: (token: string) => void = () => undefined;
    const native = provider({
      requestToken: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveToken = resolve;
          }),
      ),
    });
    const pending = attestationHeaders({ provider: native, sha256 }, 'login', 'ts-1');
    await vi.advanceTimersByTimeAsync(ATTESTATION_TIMEOUT_MS);
    resolveToken(INTEGRITY_TOKEN);
    await expect(pending).resolves.toEqual({});
  });
});

describe('warmUpAttestation', () => {
  it('starts the provider setup and swallows its errors', () => {
    const native = provider();
    warmUpAttestation({ provider: native, sha256 });
    expect(native.warmUp).toHaveBeenCalledTimes(1);

    const throwing = provider({
      warmUp: () => {
        throw new Error('boom');
      },
    });
    expect(() => {
      warmUpAttestation({ provider: throwing, sha256 });
    }).not.toThrow();
    expect(() => {
      warmUpAttestation(undefined);
    }).not.toThrow();
  });
});
