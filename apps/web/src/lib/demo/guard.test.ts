import { describe, expect, it } from 'vitest';

import { resolveDemoMode } from './guard';

describe('resolveDemoMode', () => {
  it('is off when the flag is unset or not exactly 1', () => {
    expect(resolveDemoMode({})).toBe(false);
    expect(resolveDemoMode({ NEXT_PUBLIC_DEMO_MODE: '' })).toBe(false);
    expect(resolveDemoMode({ NEXT_PUBLIC_DEMO_MODE: 'true' })).toBe(false);
    expect(resolveDemoMode({ NEXT_PUBLIC_DEMO_MODE: '0' })).toBe(false);
  });

  it('is off for a production build without the flag', () => {
    expect(
      resolveDemoMode({ APP_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.athlya.app' }),
    ).toBe(false);
  });

  it('is on for a test build', () => {
    expect(
      resolveDemoMode({
        NEXT_PUBLIC_DEMO_MODE: '1',
        APP_ENV: 'staging',
        NEXT_PUBLIC_API_URL: 'https://athlya-api.invalid',
      }),
    ).toBe(true);
    expect(resolveDemoMode({ NEXT_PUBLIC_DEMO_MODE: '1' })).toBe(true);
  });

  it('refuses APP_ENV=production', () => {
    expect(() => resolveDemoMode({ NEXT_PUBLIC_DEMO_MODE: '1', APP_ENV: 'production' })).toThrow(
      /APP_ENV=production/u,
    );
  });

  it('refuses APP_ENV=production whatever its case or padding', () => {
    for (const appEnv of ['Production', 'PRODUCTION', ' production ']) {
      expect(() => resolveDemoMode({ NEXT_PUBLIC_DEMO_MODE: '1', APP_ENV: appEnv })).toThrow(
        /APP_ENV=production/u,
      );
    }
  });

  it('refuses the production API origin written with a trailing dot', () => {
    expect(() =>
      resolveDemoMode({
        NEXT_PUBLIC_DEMO_MODE: '1',
        NEXT_PUBLIC_API_URL: 'https://api.athlya.app./v1',
      }),
    ).toThrow(/production API/u);
  });

  it('refuses the production API origin, whatever its path or case', () => {
    for (const url of [
      'https://api.athlya.app',
      'https://API.athlya.app/',
      'https://api.athlya.app/v1',
    ]) {
      expect(() =>
        resolveDemoMode({
          NEXT_PUBLIC_DEMO_MODE: '1',
          APP_ENV: 'staging',
          NEXT_PUBLIC_API_URL: url,
        }),
      ).toThrow(/production API/u);
    }
  });

  it('accepts the staging API origin', () => {
    expect(
      resolveDemoMode({
        NEXT_PUBLIC_DEMO_MODE: '1',
        NEXT_PUBLIC_API_URL: 'https://staging.api.athlya.app',
      }),
    ).toBe(true);
  });
});
