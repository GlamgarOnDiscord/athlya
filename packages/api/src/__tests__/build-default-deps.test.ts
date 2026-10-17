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

const ALL_BUT_JWT_KID = {
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
        `missing required secret(s) in ${environment}: DB_URL, REDIS_URL, REDIS_TOKEN, JWT_JWKS_URL, JWT_KID`,
      );
    },
  );

  it('reports a preview Worker without JWT_KID', () => {
    expect(() => buildDefaultDeps(envFor('preview', ALL_BUT_JWT_KID))).toThrow(
      'missing required secret(s) in preview: JWT_KID.',
    );
  });
});
