/**
 * Pure parts of the test-accounts seed (issue #758): the account plan,
 * the production guard and the environment checks. The script itself is
 * never run here.
 */
import { describe, expect, it } from 'vitest';

import {
  CONSENTS_VERSION,
  TEST_ACCOUNTS,
  TEST_STUDIO,
  parseArgs,
  readSeedEnvironment,
  seedConsents,
} from '../scripts/seed-test-accounts-lib.mjs';

const PASSWORD = 'correct horse battery staple';

describe('test account plan', () => {
  it('seeds one account per role in Studio Rive Gauche', () => {
    expect(TEST_STUDIO).toEqual({ slug: 'studio-rive-gauche', name: 'Studio Rive Gauche' });
    expect(TEST_ACCOUNTS.map((a) => a.role)).toEqual([
      'admin',
      'manager',
      'accueil',
      'coach',
      'member',
    ]);
    expect(TEST_ACCOUNTS.find((a) => a.role === 'admin')?.displayName).toBe('Camille Durand');
    expect(TEST_ACCOUNTS.find((a) => a.role === 'coach')?.displayName).toBe('Inès Garnier');
    expect(TEST_ACCOUNTS.find((a) => a.role === 'member')?.displayName).toBe('Léa Fontaine');
  });

  it('uses distinct lowercase addresses on the reserved .test domain', () => {
    const emails = TEST_ACCOUNTS.map((a) => a.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const email of emails) {
      expect(email).toBe(email.toLowerCase());
      expect(email.endsWith('.athlya.test')).toBe(true);
    }
  });

  it('records the current CGU version with every optional purpose off', () => {
    expect(seedConsents(new Date('2026-10-21T08:00:00.000Z'))).toEqual({
      marketing: false,
      analytics: false,
      thirdParty: false,
      version: CONSENTS_VERSION,
      updatedAt: '2026-10-21T08:00:00.000Z',
    });
  });
});

describe('parseArgs', () => {
  it('reads --allow-production and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ allowProduction: false });
    expect(parseArgs(['--allow-production'])).toEqual({ allowProduction: true });
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument/u);
  });
});

describe('readSeedEnvironment', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/athlya', TEST_ACCOUNTS_PASSWORD: PASSWORD };

  it('returns the connection string and the password', () => {
    expect(readSeedEnvironment(base, { allowProduction: false })).toEqual({
      databaseUrl: base.DATABASE_URL,
      password: PASSWORD,
    });
  });

  it('refuses production unless explicitly allowed', () => {
    const env = { ...base, APP_ENV: 'Production' };
    expect(() => readSeedEnvironment(env, { allowProduction: false })).toThrow(/production/u);
    expect(readSeedEnvironment(env, { allowProduction: true }).password).toBe(PASSWORD);
  });

  it('requires both variables, without echoing their values', () => {
    expect(() =>
      readSeedEnvironment({ ...base, DATABASE_URL: '' }, { allowProduction: false }),
    ).toThrow('DATABASE_URL is required');
    expect(() =>
      readSeedEnvironment({ DATABASE_URL: base.DATABASE_URL }, { allowProduction: false }),
    ).toThrow('TEST_ACCOUNTS_PASSWORD is required');
  });

  it('enforces the register length floor and the bcrypt byte ceiling', () => {
    const short = { ...base, TEST_ACCOUNTS_PASSWORD: 'short' };
    const long = { ...base, TEST_ACCOUNTS_PASSWORD: 'é'.repeat(40) };
    expect(() => readSeedEnvironment(short, { allowProduction: false })).toThrow(/at least 12/u);
    expect(() => readSeedEnvironment(long, { allowProduction: false })).toThrow(/72 bytes/u);
    for (const env of [short, long]) {
      try {
        readSeedEnvironment(env, { allowProduction: false });
      } catch (err) {
        expect(String(err)).not.toContain(env.TEST_ACCOUNTS_PASSWORD);
      }
    }
  });
});
