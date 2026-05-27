import { describe, expect, it } from 'vitest';

import {
  resolvePostgresWriteUrl,
  usesHyperdriveWritePath,
} from '../adapters/postgres-write-url.js';

import type { AthlyaBindings } from '../types.js';

function baseEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  return {
    ENVIRONMENT: 'dev',
    EVENTS_QUEUE: {} as AthlyaBindings['EVENTS_QUEUE'],
    EVENTS_DLQ: {} as AthlyaBindings['EVENTS_DLQ'],
    DB_URL: 'postgres://direct/neondb',
    REDIS_URL: 'https://redis.example',
    REDIS_TOKEN: 'token',
    JWT_JWKS_URL: 'https://jwks.example',
    VERSION: 'test',
    ...overrides,
  };
}

describe('resolvePostgresWriteUrl', () => {
  it('falls back to DB_URL when Hyperdrive is absent', () => {
    const env = baseEnv();
    expect(resolvePostgresWriteUrl(env)).toBe('postgres://direct/neondb');
    expect(usesHyperdriveWritePath(env)).toBe(false);
  });

  it('prefers Hyperdrive connectionString when bound', () => {
    const env = baseEnv({
      HYPERDRIVE: { connectionString: 'postgres://hyperdrive/pool' },
    });
    expect(resolvePostgresWriteUrl(env)).toBe('postgres://hyperdrive/pool');
    expect(usesHyperdriveWritePath(env)).toBe(true);
  });
});
