/**
 * `buildDefaultDeps` refuses to start a deployed Worker (production,
 * staging, preview) whose required secrets are missing, naming them,
 * instead of failing later on an unwired idempotency dep.
 */

import { describe, expect, it } from 'vitest';

import { buildDefaultDeps } from '../domain-deps.js';

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
  it.each(['production', 'staging', 'preview'] as const)(
    'names every missing secret in %s',
    (environment) => {
      expect(() => buildDefaultDeps(envFor(environment))).toThrow(
        `missing required secret(s) in ${environment}: DB_URL, REDIS_URL, REDIS_TOKEN, JWT_JWKS_URL, JWT_KID.`,
      );
    },
  );

  it('requires the signing key material and JWKS_JSON in preview', () => {
    expect(() =>
      buildDefaultDeps(envFor('preview', { ...CONNECTIONS, JWT_KID: 'preview-1' })),
    ).toThrow(
      'missing required secret(s) in preview: JWT_PRIVATE_KEY_PEM, JWT_PUBLIC_KEY_PEM, JWKS_JSON.',
    );
  });

  it('does not require JWKS_JSON outside preview', () => {
    expect(() =>
      buildDefaultDeps(envFor('staging', { ...CONNECTIONS, JWT_KID: 'staging-1' })),
    ).toThrow('missing required secret(s) in staging: JWT_PRIVATE_KEY_PEM, JWT_PUBLIC_KEY_PEM.');
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
