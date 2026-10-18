/**
 * `buildCheckinsDeps().issueToken` (issue #654): a 120 s RS256
 * `QR_Checkin_Token` signed with the Worker key, verifiable with the
 * JWKS the check-in side uses, and a loud error without key material.
 */

import { verifyAccessQR } from '@athlya/auth/qr';
import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetCheckinKeysForTests,
  buildCheckinsDeps,
  createAtomicReplayStore,
  createQrVerifier,
  loadQrKeys,
} from '../../adapters/checkins-deps.js';
import { defaultCheckinsDeps } from '../../domain-deps.js';
import { buildMockEnv } from '../helpers/test-app.js';

import type { AuthClaims } from '../../middleware/auth.js';
import type { Jwks } from '@athlya/auth/jwt';
import type { Redis } from '@upstash/redis';

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW_MS = Date.parse('2026-10-18T10:00:00Z');
const claims = { userId: USER, studioId: STUDIO, role: 'member' } as AuthClaims;

let privatePem = '';
let publicPem = '';
let jwks: Jwks;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privatePem = await exportPKCS8(pair.privateKey);
  publicPem = await exportSPKI(pair.publicKey);
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] };
});

beforeEach(() => {
  __resetCheckinKeysForTests();
});

function memoryRedis(): Pick<Redis, 'get' | 'set'> {
  const keys = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(keys.get(key) ?? null),
    set: (key: string, value: string, opts?: { nx?: boolean }) => {
      if (opts?.nx === true && keys.has(key)) return Promise.resolve(null);
      keys.set(key, value);
      return Promise.resolve('OK');
    },
  } as unknown as Pick<Redis, 'get' | 'set'>;
}

describe('buildCheckinsDeps().issueToken', () => {
  it('issues a 120 s token for the caller that the check-in side verifies', async () => {
    const env = buildMockEnv({
      JWT_KID: 'k1',
      JWT_PRIVATE_KEY_PEM: privatePem,
      JWT_PUBLIC_KEY_PEM: publicPem,
      JWKS_JSON: JSON.stringify(jwks),
    } as never);
    const deps = buildCheckinsDeps(env, { now: () => NOW_MS });

    const issued = await deps.issueToken(claims);

    expect(issued.expiresAt).toBe('2026-10-18T10:02:00.000Z');
    const verified = await verifyAccessQR(issued.token, STUDIO, {
      jwks,
      replayStore: createAtomicReplayStore(memoryRedis()),
      now: () => Math.floor(NOW_MS / 1000) + 60,
    });
    expect(verified.userId).toBe(USER);
  });

  it('falls back to the current public key when JWKS_JSON is not set', async () => {
    const env = buildMockEnv({
      JWT_KID: 'k1',
      JWT_PRIVATE_KEY_PEM: privatePem,
      JWT_PUBLIC_KEY_PEM: publicPem,
      JWKS_JSON: '',
    } as never);
    const deps = buildCheckinsDeps(env, { now: () => NOW_MS });
    const issued = await deps.issueToken(claims);

    // The check-in side verifies with the derived JWKS.
    const { jwks: derived } = await loadQrKeys(env);
    const verifier = createQrVerifier(
      derived,
      createAtomicReplayStore(memoryRedis()),
      () => NOW_MS + 60_000,
    );
    await expect(verifier.verify(issued.token, STUDIO)).resolves.toMatchObject({
      ok: true,
      userId: USER,
    });
  });

  it('fails loudly without the signing key', async () => {
    const env = buildMockEnv({ JWT_KID: 'k1', JWT_PRIVATE_KEY_PEM: '' } as never);
    const deps = buildCheckinsDeps(env, { now: () => NOW_MS });
    await expect(deps.issueToken(claims)).rejects.toThrow(/JWT_PRIVATE_KEY_PEM/u);
  });
});

describe('defaultCheckinsDeps', () => {
  const wired = {
    DB_URL: 'postgres://u:p@db.invalid/athlya',
    REDIS_URL: 'https://redis.invalid',
  };

  it('refuses to build in a deployed environment without the signing key pair', () => {
    const env = buildMockEnv({
      ...wired,
      ENVIRONMENT: 'staging',
      JWT_PRIVATE_KEY_PEM: '',
      JWT_PUBLIC_KEY_PEM: '',
    } as never);
    expect(() => defaultCheckinsDeps(env)).toThrow(/JWT_PRIVATE_KEY_PEM/u);
  });

  it('builds with the key pair, and keeps the stub without DB or Redis', () => {
    const keyed = buildMockEnv({
      ...wired,
      ENVIRONMENT: 'staging',
      JWT_PRIVATE_KEY_PEM: privatePem,
      JWT_PUBLIC_KEY_PEM: publicPem,
    } as never);
    expect(defaultCheckinsDeps(keyed).idempotencyFor).toBeTypeOf('function');
    const stub = defaultCheckinsDeps(buildMockEnv({ ENVIRONMENT: 'staging', DB_URL: '' } as never));
    expect(stub.idempotencyFor).toBeUndefined();
  });
});

describe('createAtomicReplayStore', () => {
  it('consumes a jti once: a second add throws QRReplayError', async () => {
    const store = createAtomicReplayStore(memoryRedis());
    expect(await store.has('j1')).toBe(false);
    await store.add('j1', 120);
    expect(await store.has('j1')).toBe(true);
    await expect(store.add('j1', 120)).rejects.toMatchObject({ code: 'replay' });
  });
});
