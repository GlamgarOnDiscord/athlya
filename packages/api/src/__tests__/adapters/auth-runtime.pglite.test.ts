/**
 * Auth runtime paths against the real migration chain, run as the
 * `athlya_app` runtime role (issue #645).
 *
 * PGlite applies every forward migration, so the roles, grants, RLS
 * policies and SECURITY DEFINER functions are the production ones. The
 * session switches to `athlya_app` (NOBYPASSRLS) after seeding.
 *
 *   A. Password-reset requests are recorded in the outbox by
 *      `auth_request_password_reset` (0043) without tenant claims, and
 *      the drained event is delivered by the consumer: token issued
 *      through `auth_issue_password_reset`, email sent.
 *   B. `idempotency_keys` is owner-only (`user_id = app_user_id()`): a
 *      store without the caller's claims misses every lookup and has its
 *      write refused. The store bound to the caller's claims replays.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResetTokenDeriver } from '@athlya/auth';
import { lookup, store } from '@athlya/db/idempotency';
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
import { createTenantIdempotencyDb } from '../../adapters/tenant-idempotency.js';
import { reconstructEnvelope } from '../../events/drain-worker.js';
import { handlePasswordResetRequested } from '../../events/password-reset-consumer.js';

import type { DeliveryStoreRedis } from '../../adapters/password-reset-delivery-store-redis.js';
import type { AthlyaDb, AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { IdempotencyDb } from '@athlya/db/idempotency';
import type { SQL } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const DELETED_A = '11111111-1111-4111-8111-111111111119';

const memberA: TenantClaims = { userId: MEMBER_A, studioId: STUDIO_A, role: 'member' };
const memberA2: TenantClaims = { userId: MEMBER_A2, studioId: STUDIO_A, role: 'member' };

let pglite: PGlite;
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

/**
 * Neon HTTP stand-in: `execute` only builds the statement and `batch`
 * runs the statements in one transaction, like Neon's HTTP batch API.
 * This is the handle shape `withTenantHttp` drives.
 */
function neonHttpLike(): AthlyaDbHttp {
  return {
    execute: (query: SQL) => query,
    batch: (queries: readonly SQL[]) =>
      db.transaction(async (tx) => {
        const results: unknown[] = [];
        for (const query of queries) results.push(await tx.execute(query));
        return results;
      }),
  } as unknown as AthlyaDbHttp;
}

/** Drizzle wraps the driver error; the RLS refusal is its cause. */
async function expectRlsRefusal(promise: Promise<unknown>): Promise<void> {
  const err: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  const cause = (err as Error & { cause?: unknown }).cause;
  const message = cause instanceof Error ? cause.message : (err as Error).message;
  expect(message).toMatch(/row-level security/u);
}

/** In-memory stand-in for the Upstash client (`SET NX`, `GET`, `DEL`). */
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
  public del(key: string): Promise<unknown> {
    this.values.delete(key);
    return Promise.resolve(1);
  }
}

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
    INSERT INTO users (id, studio_id, email, display_name, role, consents, deleted_at)
    SELECT id::uuid, '${STUDIO_A}'::uuid, email, name, 'member'::user_role,
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb,
           deleted::timestamptz
      FROM (VALUES
        ('${MEMBER_A}',  'member-a@test.dev',  'Member A',  NULL),
        ('${MEMBER_A2}', 'member-a2@test.dev', 'Member A2', NULL),
        ('${DELETED_A}', 'deleted-a@test.dev', 'Deleted A', '2026-01-01T00:00:00Z')
      ) AS seed (id, email, name, deleted);
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

it('runs as a NOBYPASSRLS role', async () => {
  const { rows } = await pglite.query<{ role: string; bypass: boolean; superuser: boolean }>(
    `SELECT current_user AS role, rolbypassrls AS bypass, rolsuper AS superuser
       FROM pg_roles WHERE rolname = current_user`,
  );
  expect(rows[0]).toEqual({ role: 'athlya_app', bypass: false, superuser: false });
});

/* ------------------------------------------------------------------ */
/*  A. Password-reset requests through the outbox                     */
/* ------------------------------------------------------------------ */

interface OutboxRow {
  readonly id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: Date;
  readonly studio_id: string | null;
  readonly attempts: number;
}

const resetRows = () =>
  asOwner<OutboxRow>(
    `SELECT id, event_id, event_type, payload, occurred_at, studio_id::text AS studio_id, attempts
       FROM outbox WHERE event_type = 'auth.password_reset.requested' ORDER BY occurred_at`,
  );

describe('password-reset request → outbox → delivery under athlya_app', () => {
  beforeEach(async () => {
    await asOwner(`DELETE FROM outbox WHERE event_type = 'auth.password_reset.requested'`);
  });

  it('records one event for a live account, carrying the account id only', async () => {
    await createPasswordResetRequestQueue(db).enqueue('member-a@test.dev');

    const rows = await resetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.studio_id).toBe(STUDIO_A);
    expect(rows[0]?.payload).toEqual({ userId: MEMBER_A });
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('@');
  });

  it('records nothing for an unknown or a soft-deleted address', async () => {
    const queue = createPasswordResetRequestQueue(db);
    await queue.enqueue('nobody@test.dev');
    await queue.enqueue('deleted-a@test.dev');

    expect(await resetRows()).toEqual([]);
  });

  it('cannot write the outbox directly without tenant claims', async () => {
    await expect(
      pglite.query(
        `INSERT INTO outbox (event_id, event_type, payload, occurred_at)
         VALUES ('forged', 'auth.password_reset.requested', '{}'::jsonb, now())`,
      ),
    ).rejects.toThrow(/row-level security|permission denied/u);
  });

  it('records one row when a committed enqueue is replayed with the same event id', async () => {
    const eventId = '0193f000-0000-7000-8000-0000000006a1';
    await pglite.query(`SELECT auth_request_password_reset($1, $2::uuid)`, [
      'member-a@test.dev',
      eventId,
    ]);
    // The response of the first call was lost; the connection retry
    // replays the same statement.
    await pglite.query(`SELECT auth_request_password_reset($1, $2::uuid)`, [
      'member-a@test.dev',
      eventId,
    ]);

    const rows = await resetRows();
    expect(rows.map((r) => r.event_id)).toEqual([eventId]);
  });

  it('delivers the drained event: one active token, link sent to the account address', async () => {
    await createPasswordResetRequestQueue(db).enqueue('MEMBER-A@test.dev');
    const [row] = await resetRows();
    if (row === undefined) throw new Error('no outbox row recorded');

    const event = parseEvent(
      reconstructEnvelope({
        id: row.id,
        eventId: row.event_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        studioId: row.studio_id,
        attempts: row.attempts,
      }),
    );
    if (event.type !== 'auth.password_reset.requested') throw new Error(event.type);

    const sendResetEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(undefined);
    const consumerDeps = {
      deliveries: createRedisPasswordResetDeliveryStore(new MemoryRedis()),
      delivery: {
        userRepo: createDrizzleUserRepo(db),
        tokens: createPasswordResetRequestTokenStore(db),
        emailTransport: { sendResetEmail },
        deriveToken: createResetTokenDeriver('k'.repeat(32)),
        resetLinkBaseUrl: 'https://app.athlya.test',
      },
    };

    // First attempt: ambiguous transport failure; the queue retries.
    await expect(handlePasswordResetRequested(event, consumerDeps)).rejects.toThrow(
      'socket hang up',
    );
    const outcome = await handlePasswordResetRequested(event, consumerDeps);

    expect(outcome).toBe('sent');
    const links = (sendResetEmail.mock.calls as [{ to: string; link: string }][]).map(
      ([input]) => input,
    );
    expect(links.map((l) => l.to)).toEqual(['member-a@test.dev', 'member-a@test.dev']);
    expect(links[1]?.link).toBe(links[0]?.link);
    const token = links[0]!.link.split('/').pop()!;
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // The retry found its own token instead of invalidating it: the link
    // possibly delivered by the first attempt still works.
    const tokens = await asOwner<{ token_hash: string; consumed: boolean }>(
      `SELECT token_hash, consumed_at IS NOT NULL AS consumed FROM password_reset_tokens
        WHERE user_id = $1 ORDER BY requested_at`,
      [MEMBER_A],
    );
    expect(tokens.filter((t) => !t.consumed)).toEqual([{ token_hash: tokenHash, consumed: false }]);
    expect(tokens.filter((t) => t.token_hash === tokenHash)).toHaveLength(1);
  });

  it('issueForRequest: a later request supersedes an earlier token', async () => {
    const store = createPasswordResetRequestTokenStore(db);
    const expiresAt = new Date(Date.now() + 3_600_000);

    await expect(
      store.issueForRequest({ userId: MEMBER_A2, tokenHash: 'a'.repeat(64), expiresAt }),
    ).resolves.toBe('issued');
    await expect(
      store.issueForRequest({ userId: MEMBER_A2, tokenHash: 'b'.repeat(64), expiresAt }),
    ).resolves.toBe('issued');
    await expect(
      store.issueForRequest({ userId: MEMBER_A2, tokenHash: 'a'.repeat(64), expiresAt }),
    ).resolves.toBe('superseded');
    await expect(
      store.issueForRequest({ userId: DELETED_A, tokenHash: 'c'.repeat(64), expiresAt }),
    ).resolves.toBe('inactive');
  });

  it('issueForRequest: refuses a hash owned by another user', async () => {
    const store = createPasswordResetRequestTokenStore(db);
    const expiresAt = new Date(Date.now() + 3_600_000);

    await expect(
      store.issueForRequest({ userId: MEMBER_A, tokenHash: 'b'.repeat(64), expiresAt }),
    ).rejects.toThrow();
  });
});
/* ------------------------------------------------------------------ */
/*  B. Idempotency store scope                                        */
/* ------------------------------------------------------------------ */

describe('idempotency_keys under athlya_app', () => {
  const response = { body: { deleted: true }, statusCode: 200 };

  it('reproduces the bug: a claim-less store has its write refused', async () => {
    await expectRlsRefusal(store(db, 'claimless-key', MEMBER_A, response, 60));
  });

  it('reproduces the bug: a claim-less lookup misses an existing row', async () => {
    await asOwner(
      `INSERT INTO idempotency_keys (key, user_id, response, status_code, expires_at)
       VALUES ('owner-key', $1, '{"deleted":true}'::jsonb, 200, now() + interval '1 hour')`,
      [MEMBER_A],
    );
    await expect(lookup(db as IdempotencyDb, 'owner-key', MEMBER_A)).resolves.toBeNull();
  });

  it('stores and replays through the store bound to the caller claims', async () => {
    const scoped = createTenantIdempotencyDb(neonHttpLike(), memberA);

    await store(scoped, 'scoped-key', MEMBER_A, response, 60);
    const hit = await lookup(scoped, 'scoped-key', MEMBER_A);

    expect(hit?.response).toEqual({ deleted: true });
    expect(hit?.statusCode).toBe(200);
  });

  it('keeps another user from reading or writing the caller rows', async () => {
    const other = createTenantIdempotencyDb(neonHttpLike(), memberA2);

    await expect(lookup(other, 'scoped-key', MEMBER_A)).resolves.toBeNull();
    await expectRlsRefusal(store(other, 'forged-key', MEMBER_A, response, 60));
  });
});
