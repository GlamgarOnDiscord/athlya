/**
 * `buildDefaultDeps` refuses to start a deployed Worker (production,
 * staging, preview) whose required secrets are missing, naming them,
 * instead of failing later on an unwired idempotency dep.
 */

import { describe, expect, it } from 'vitest';

import { buildDefaultDeps } from '../routes/index.js';

import type { AthlyaBindings } from '../types.js';

function envFor(environment: AthlyaBindings['ENVIRONMENT'], extra: Record<string, string> = {}) {
  return { ENVIRONMENT: environment, ...extra } as unknown as AthlyaBindings;
}

const CONNECTIONS = {
  DB_URL: 'postgres://athlya_app:secret@db.example.test/neondb',
  REDIS_URL: 'https://redis.example.test',
  REDIS_TOKEN: 'token',
  JWT_JWKS_URL: 'https://api.example.test/.well-known/jwks.json',
};

describe('buildDefaultDeps required secrets', () => {
  it.each(['production', 'staging'] as const)('names every missing secret in %s', (environment) => {
    expect(() => buildDefaultDeps(envFor(environment))).toThrow(
      `missing required secret(s) in ${environment}: DB_URL, REDIS_URL, REDIS_TOKEN, JWT_JWKS_URL, JWT_KID.`,
    );
  });

  it('also requires the signing key material in preview', () => {
    expect(() => buildDefaultDeps(envFor('preview'))).toThrow(
      'missing required secret(s) in preview: DB_URL, REDIS_URL, REDIS_TOKEN, JWT_JWKS_URL, JWT_KID, JWT_PRIVATE_KEY_PEM, JWT_PUBLIC_KEY_PEM, JWKS_JSON.',
    );
  });

  it('reports a preview Worker with JWT_KID but no key material', () => {
    expect(() =>
      buildDefaultDeps(envFor('preview', { ...CONNECTIONS, JWT_KID: 'preview-1' })),
    ).toThrow(
      'missing required secret(s) in preview: JWT_PRIVATE_KEY_PEM, JWT_PUBLIC_KEY_PEM, JWKS_JSON.',
    );
  });

  it('reports a preview Worker without JWT_KID', () => {
    expect(() =>
      buildDefaultDeps(
        envFor('preview', {
          ...CONNECTIONS,
          JWT_PRIVATE_KEY_PEM: 'pem',
          JWT_PUBLIC_KEY_PEM: 'pem',
          JWKS_JSON: '{"keys":[]}',
        }),
      ),
    ).toThrow('missing required secret(s) in preview: JWT_KID.');
  });
});
