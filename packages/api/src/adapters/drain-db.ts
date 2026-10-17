/**
 * Database binding for the scheduled outbox drain — issue #497.
 *
 * The drain claims and marks outbox rows as `athlya_cron` (CRON_DB_URL):
 * a NOBYPASSRLS role whose policies (migrations 0019 + 0031) allow
 * SELECT/UPDATE(attempts, published_at)/DELETE on `outbox` and nothing
 * that would let it forge or rewrite events. The tenant `DB_URL` role
 * (`athlya_app`) deliberately cannot drain.
 *
 * Dev may run without CRON_DB_URL and falls back to DB_URL; staging and
 * production skip the drain (with a configuration error log) instead of
 * draining under the wrong role.
 */

import { createDb, type AthlyaDb } from '@athlya/db/client';

import { isCronDbUrlConfigured } from '../maintenance/cron-db-config.js';

interface DrainDbEnv {
  readonly ENVIRONMENT?: string;
  readonly CRON_DB_URL?: string;
  readonly DB_URL?: string;
}

export function resolveDrainDbUrl(env: DrainDbEnv): string | null {
  if (isCronDbUrlConfigured(env.CRON_DB_URL)) {
    return env.CRON_DB_URL as string;
  }
  if (env.ENVIRONMENT === 'dev' && typeof env.DB_URL === 'string' && env.DB_URL !== '') {
    return env.DB_URL;
  }
  return null;
}

/**
 * A fresh postgres-js handle per cron tick: direct TCP clients must not
 * outlive the invocation on Workers (same rule as the write path).
 */
export function createDrainDb(url: string): AthlyaDb {
  return createDb(url, { maxConnections: 1, idleTimeoutSec: 5 });
}
