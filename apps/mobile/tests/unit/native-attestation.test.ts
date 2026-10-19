import { beforeEach, describe, expect, it, vi } from 'vitest';

const integrity = vi.hoisted(() => ({
  prepareIntegrityTokenProviderAsync: vi.fn<(cloudProjectNumber: string) => Promise<void>>(),
  requestIntegrityCheckAsync: vi.fn<(requestHash: string) => Promise<string>>(),
}));

const expo = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn<(name: string) => unknown>(),
}));

vi.mock('@expo/app-integrity', () => integrity);
vi.mock('expo', () => expo);

const { createDeviceCheckProvider, createNativeAttestationProvider, createPlayIntegrityProvider } =
  await import('../../infrastructure/attestation/native-attestation');

const PROJECT_NUMBER = '123456789012';
const REQUEST_HASH = 'D1PSGm8sQpi4NV48vAmQ17aiAKxQFzjXWdBemeWmyaA';

beforeEach(() => {
  vi.clearAllMocks();
  integrity.prepareIntegrityTokenProviderAsync.mockResolvedValue(undefined);
  integrity.requestIntegrityCheckAsync.mockResolvedValue('integrity-0000');
  expo.requireOptionalNativeModule.mockReturnValue(null);
});

describe('createPlayIntegrityProvider', () => {
  it('is null without a valid Cloud project number', () => {
    expect(createPlayIntegrityProvider(undefined)).toBeNull();
    expect(createPlayIntegrityProvider('')).toBeNull();
    expect(createPlayIntegrityProvider('my-project')).toBeNull();
  });

  it('prepares the token provider once, then requests a token per call', async () => {
    const provider = createPlayIntegrityProvider(` ${PROJECT_NUMBER} `);
    expect(provider?.platform).toBe('android');

    provider?.warmUp();
    await expect(provider?.requestToken(REQUEST_HASH)).resolves.toBe('integrity-0000');
    await expect(provider?.requestToken('other-hash')).resolves.toBe('integrity-0000');

    expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(1);
    expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledWith(PROJECT_NUMBER);
    expect(integrity.requestIntegrityCheckAsync.mock.calls).toEqual([
      [REQUEST_HASH],
      ['other-hash'],
    ]);
  });

  it('prepares again after a failed preparation', async () => {
    integrity.prepareIntegrityTokenProviderAsync.mockRejectedValueOnce(new Error('no play'));
    const provider = createPlayIntegrityProvider(PROJECT_NUMBER);

    await expect(provider?.requestToken(REQUEST_HASH)).rejects.toThrow('no play');
    await expect(provider?.requestToken(REQUEST_HASH)).resolves.toBe('integrity-0000');
    expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(2);
  });

  it('prepares again after a failed request (expired provider)', async () => {
    integrity.requestIntegrityCheckAsync.mockRejectedValueOnce(new Error('provider invalid'));
    const provider = createPlayIntegrityProvider(PROJECT_NUMBER);

    await expect(provider?.requestToken(REQUEST_HASH)).rejects.toThrow('provider invalid');
    await expect(provider?.requestToken(REQUEST_HASH)).resolves.toBe('integrity-0000');
    expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed warm-up', async () => {
    integrity.prepareIntegrityTokenProviderAsync.mockRejectedValueOnce(new Error('no play'));
    const provider = createPlayIntegrityProvider(PROJECT_NUMBER);
    expect(() => provider?.warmUp()).not.toThrow();
    await vi.waitFor(() => {
      expect(integrity.prepareIntegrityTokenProviderAsync).toHaveBeenCalledTimes(1);
    });
    await expect(provider?.requestToken(REQUEST_HASH)).resolves.toBe('integrity-0000');
  });
});

describe('createDeviceCheckProvider', () => {
  it('is null when the native module is missing, unsupported or fails to load', () => {
    expect(createDeviceCheckProvider()).toBeNull();

    expo.requireOptionalNativeModule.mockReturnValue({ isSupported: false });
    expect(createDeviceCheckProvider()).toBeNull();

    expo.requireOptionalNativeModule.mockImplementation(() => {
      throw new Error('not linked');
    });
    expect(createDeviceCheckProvider()).toBeNull();
  });

  it('returns the DeviceCheck token and ignores the request hash', async () => {
    const generateTokenAsync = vi.fn(() => Promise.resolve('devicecheck-0000'));
    expo.requireOptionalNativeModule.mockReturnValue({ isSupported: true, generateTokenAsync });

    const provider = createDeviceCheckProvider();
    expect(expo.requireOptionalNativeModule).toHaveBeenCalledWith('AthlyaDeviceCheck');
    expect(provider?.platform).toBe('ios');
    provider?.warmUp();
    await expect(provider?.requestToken(REQUEST_HASH)).resolves.toBe('devicecheck-0000');
    expect(generateTokenAsync).toHaveBeenCalledTimes(1);
  });
});

describe('createNativeAttestationProvider', () => {
  it('picks the adapter for the platform', () => {
    expo.requireOptionalNativeModule.mockReturnValue({
      isSupported: true,
      generateTokenAsync: vi.fn(),
    });
    expect(
      createNativeAttestationProvider({ os: 'android', cloudProjectNumber: PROJECT_NUMBER })
        ?.platform,
    ).toBe('android');
    expect(
      createNativeAttestationProvider({ os: 'ios', cloudProjectNumber: undefined })?.platform,
    ).toBe('ios');
    expect(
      createNativeAttestationProvider({ os: 'android', cloudProjectNumber: undefined }),
    ).toBeNull();
    expect(
      createNativeAttestationProvider({ os: 'web', cloudProjectNumber: PROJECT_NUMBER }),
    ).toBeNull();
  });
});
