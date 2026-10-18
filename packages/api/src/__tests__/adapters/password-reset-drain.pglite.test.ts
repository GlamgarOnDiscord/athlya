/**
 * `auth.password_reset.requested` through the real outbox drain
 * (issue #650 follow-up).
 *
 * PGlite applies every forward migration. The request is recorded as
 * `athlya_app` by `auth_request_password_reset` (0043); the drain runs
 * as `athlya_cron` through `runScheduledDrain`, the cron / kick entry
 * point, with the leased claim, routing and stamping used in
 * production. Only the Cloudflare queue producers are doubles.
 *
 * Covered: the row reaches the notifications lane once, with the
 * envelope the consumer parses; it is stamped published; a failed send
 * leaves it pending and the next drain redelivers the same event id;
 * a redelivered envelope sends a single email.
 *
 * The drain gets the handle shape production's postgres-js client has,
 * whose drizzle wrapper returns `occurred_at` as text: before the
 * claim mapped it onto a `Date`, every send failed on `toISOString`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResetTokenDeriver } from '@athlya/auth';
import * as schema from '@athlya/db/schema';
import { parseEvent } from '@athlya/shared/events';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDrizzleUserRepo } from '../../adapters/auth-user-repo-drizzle.js';
import { createRedisPasswordResetDeliveryStore } from '../../adapters/password-reset-delivery-store-redis.js';
import {
  createPasswordResetRequestQueue,
  createPasswordResetRequestTokenStore,
} from '../../adapters/password-reset-repo-drizzle.js';
import { runScheduledDrain } from '../../events/drain-scheduled.js';
import { handlePasswordResetRequested } from '../../events/password-reset-consumer.js';

import type { DeliveryStoreRedis } from '../../adapters/password-reset-delivery-store-redis.js';
import type { DrainResult, Logger } from '../../events/drain-worker.js';
import type { AthlyaDb } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const EVENT_TYPE = 'auth.password_reset.requested';

let pglite: PGlite;
let pgliteDb: PgliteDatabase<typeof schema>;
let db: AthlyaDb;

/** Run a raw query as the migration owner, then switch back to athlya_app. */
async function asOwner<T>(query: string, params: unknown[] = []): Promise<T[]> {
  await pglite.exec('RESET ROLE');
  try {
    return (await pglite.query<T>(query, params)).rows;
  } finally {
    await pglite.exec('SET ROLE athlya_app');
  }
}

/** In-memory stand-in for the Upstash client (`SET NX`, `GET`, compare-and-delete). */
class MemoryRedis implements DeliveryStoreRedis {
  private readonly values = new Map<string, string>();
  public set(key: string, value: string, opts: { nx?: true; ex: number }): Promise<unknown> {
    if (opts.nx === true && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve('OK');
  }
  public get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  public eval(_script: string, keys: string[], args: string[]): Promise<unknown> {
    const [key] = keys;
    if (key === undefined || this.values.get(key) !== args[0]) return Promise.resolve(0);
    this.values.delete(key);
    return Promise.resolve(1);
  }
}

/** Queue producer double recording every message it accepts. */
function recordingQueue() {
  const sent: unknown[] = [];
  const send = vi.fn((message: unknown) => {
    sent.push(message);
    return Promise.resolve();
  });
  return { sent, send };
}

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Lanes {
  readonly notifications: ReturnType<typeof recordingQueue>;
  readonly rgpd: ReturnType<typeof recordingQueue>;
  readonly legacy: ReturnType<typeof recordingQueue>;
}

function lanes(): Lanes {
  return { notifications: recordingQueue(), rgpd: recordingQueue(), legacy: recordingQueue() };
}

/**
 * The drain's handle as production builds it (`createDb`, postgres-js):
 * `execute` resolves to the row array, and drizzle leaves timestamps as
 * the driver's text, as it does on PGlite.
 */
function postgresJsShaped(handle: PgliteDatabase<typeof schema>): AthlyaDb {
  return {
    execute: async (query: SQL) => (await handle.execute(query)).rows,
  } as unknown as AthlyaDb;
}

/** One drain cycle as `athlya_cron`, the role the cron and kick drains use. */
async function drainAsCron(queues: Lanes): Promise<DrainResult> {
  await pglite.exec('RESET ROLE; SET ROLE athlya_cron');
  try {
    return await runScheduledDrain({
      EVENTS_QUEUE: queues.legacy,
      EVENTS_NOTIFICATIONS_QUEUE: queues.notifications,
      EVENTS_RGPD_QUEUE: queues.rgpd,
      getDb: () => postgresJsShaped(pgliteDb),
      batchSize: 10,
      logger: silentLogger,
    });
  } finally {
    await pglite.exec('RESET ROLE; SET ROLE athlya_app');
  }
}

interface OutboxState {
  readonly event_id: string;
  readonly occurred_at: Date;
  readonly attempts: number;
  readonly published: boolean;
  readonly leased: boolean;
}

const resetRows = () =>
  asOwner<OutboxState>(
    `SELECT event_id, occurred_at, attempts, published_at IS NOT NULL AS published,
            lease_until IS NOT NULL AND lease_until > now() AS leased
       FROM outbox WHERE event_type = $1 ORDER BY occurred_at`,
    [EVENT_TYPE],
  );

beforeAll(async () => {
  pglite = new PGlite({ extensions: { btree_gin, citext, pgcrypto } });
  const forward = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of forward) {
    // PGlite runs a multi-statement exec as one implicit transaction,
    // where CONCURRENTLY is refused; on an empty in-memory database a
    // plain index build is equivalent.
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pglite.exec(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES ('${STUDIO_A}', 'studio-a', 'Studio A');
    INSERT INTO users (id, studio_id, email, display_name, role, consents)
    VALUES ('${MEMBER_A}', '${STUDIO_A}', 'member-a@test.dev', 'Member A', 'member',
            '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb);
    SET ROLE athlya_app;
  `);
  pgliteDb = drizzle(pglite, { schema });
  db = pgliteDb as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('auth.password_reset.requested: outbox → drain → notifications queue', () => {
  beforeEach(async () => {
    await asOwner(`DELETE FROM outbox`);
  });

  it('enqueues the event once on the notifications lane and stamps the row published', async () => {
    await createPasswordResetRequestQueue(db).enqueue('member-a@test.dev');
    const [recorded] = await resetRows();
    if (recorded === undefined) throw new Error('no outbox row recorded');

    const queues = lanes();
    const result = await drainAsCron(queues);

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, released: 0 });
    expect(queues.rgpd.sent).toEqual([]);
    expect(queues.legacy.sent).toEqual([]);
    expect(queues.notifications.sent).toEqual([
      {
        id: recorded.event_id,
        type: EVENT_TYPE,
        occurredAt: new Date(recorded.occurred_at).toISOString(),
        studioId: STUDIO_A,
        payload: { userId: MEMBER_A },
      },
    ]);
    const event = parseEvent(queues.notifications.sent[0]);
    expect(event.type).toBe(EVENT_TYPE);
    expect(JSON.stringify(queues.notifications.sent[0])).not.toContain('@');

    expect(await resetRows()).toEqual([
      expect.objectContaining({ event_id: recorded.event_id, attempts: 1, published: true }),
    ]);
  });

  it('does not enqueue a published row again', async () => {
    await createPasswordResetRequestQueue(db).enqueue('member-a@test.dev');
    await drainAsCron(lanes());

    const queues = lanes();
    const result = await drainAsCron(queues);

    expect(result.processed).toBe(0);
    expect(queues.notifications.send).not.toHaveBeenCalled();
  });

  it('leaves the row pending when the send fails and redelivers the same event id', async () => {
    await createPasswordResetRequestQueue(db).enqueue('member-a@test.dev');
    const failing = lanes();
    failing.notifications.send.mockRejectedValueOnce(new Error('queue unavailable'));

    const first = await drainAsCron(failing);

    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1, released: 0 });
    const [pending] = await resetRows();
    expect(pending).toMatchObject({ attempts: 1, published: false, leased: true });

    // While the lease of the failed attempt holds, no other drain claims it.
    const blocked = lanes();
    expect((await drainAsCron(blocked)).processed).toBe(0);
    expect(blocked.notifications.send).not.toHaveBeenCalled();

    await asOwner(`UPDATE outbox SET lease_until = now() - interval '1 second'`);
    const retry = lanes();
    const second = await drainAsCron(retry);

    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0, released: 0 });
    expect(retry.notifications.sent).toEqual([
      expect.objectContaining({ id: pending?.event_id, type: EVENT_TYPE }),
    ]);
    expect(await resetRows()).toEqual([
      expect.objectContaining({ event_id: pending?.event_id, attempts: 2, published: true }),
    ]);
  });

  it('sends one email when the drained envelope is delivered twice', async () => {
    await createPasswordResetRequestQueue(db).enqueue('member-a@test.dev');
    const queues = lanes();
    await drainAsCron(queues);
    const [message] = queues.notifications.sent;
    const event = parseEvent(message);
    if (event.type !== EVENT_TYPE) throw new Error(event.type);

    const sendResetEmail = vi.fn().mockResolvedValue(undefined);
    const deps = {
      deliveries: createRedisPasswordResetDeliveryStore(new MemoryRedis()),
      delivery: {
        userRepo: createDrizzleUserRepo(db),
        tokens: createPasswordResetRequestTokenStore(db),
        emailTransport: { sendResetEmail },
        deriveToken: createResetTokenDeriver('k'.repeat(32)),
        resetLinkBaseUrl: 'https://app.athlya.test',
      },
    };

    await expect(handlePasswordResetRequested(event, deps)).resolves.toBe('sent');
    await expect(handlePasswordResetRequested(event, deps)).resolves.toBe('skipped_duplicate');
    expect(sendResetEmail).toHaveBeenCalledTimes(1);
    expect(sendResetEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'member-a@test.dev' }),
    );
  });
});
