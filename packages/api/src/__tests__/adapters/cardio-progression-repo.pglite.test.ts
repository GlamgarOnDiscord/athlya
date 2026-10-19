/**
 * `createDrizzleCardioProgressionRepoHttp` against the real migration
 * chain, run as the `athlya_app` runtime role (issue #683).
 *
 * PGlite applies every forward migration, then the session switches to
 * `athlya_app` (NOBYPASSRLS). A Neon HTTP stand-in runs the tenant GUCs
 * and the repo statement in one transaction, like `withTenantHttp` does
 * over Neon's batch API, so the assertions below are what the
 * `workout_sessions_read_own` policy lets each caller read.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCardioProgression } from '@athlya/members';
import * as schema from '@athlya/db/schema';
import { CardioProgressionResponseSchema } from '@athlya/shared/schemas/api';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDrizzleCardioProgressionRepoHttp } from '../../adapters/cardio-progression-repo-drizzle.js';

import type { AthlyaDb, AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { SQL } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_A2 = '11111111-1111-4111-8111-111111111112';
const ADMIN_A = '11111111-1111-4111-8111-111111111113';

const memberA: TenantClaims = { userId: MEMBER_A, studioId: STUDIO_A, role: 'member' };
const memberA2: TenantClaims = { userId: MEMBER_A2, studioId: STUDIO_A, role: 'member' };
const adminA: TenantClaims = { userId: ADMIN_A, studioId: STUDIO_A, role: 'admin' };

/** Thursday 2026-10-15, 14:30 UTC. */
const NOW = Date.parse('2026-10-15T14:30:00.000Z');

const WINDOW = {
  from: new Date('2026-09-16T00:00:00.000Z'),
  to: new Date('2026-10-16T00:00:00.000Z'),
  limit: 100,
};

let pglite: PGlite;
let db: AthlyaDb;

/**
 * Neon HTTP stand-in: `execute` only builds the statement and `batch`
 * runs the statements in one transaction, like Neon's HTTP batch API.
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

const repo = (claims: TenantClaims) =>
  createDrizzleCardioProgressionRepoHttp(neonHttpLike(), claims);

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
    SELECT id::uuid, '${STUDIO_A}'::uuid, email, name, role::user_role,
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":1,"updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      FROM (VALUES
        ('${MEMBER_A}',  'member-a@test.dev',  'Member A',  'member'),
        ('${MEMBER_A2}', 'member-a2@test.dev', 'Member A2', 'member'),
        ('${ADMIN_A}',   'admin-a@test.dev',   'Admin A',   'admin')
      ) AS seed (id, email, name, role);
    INSERT INTO workout_sessions (user_id, studio_id, started_at, exercises, cardio)
    VALUES
      ('${MEMBER_A}', NULL, '2026-10-14T07:00:00Z', '[]'::jsonb,
       '{"machine":"indoorBike","durationSec":3600,"distanceM":30000,"energyKcal":700,"avgPowerW":200,"avgHeartRateBpm":150}'::jsonb),
      ('${MEMBER_A}', NULL, '2026-10-13T07:00:00Z', '[]'::jsonb,
       '{"machine":"indoorBike","durationSec":900,"distanceM":6000,"avgPowerW":100}'::jsonb),
      ('${MEMBER_A}', NULL, '2026-10-01T18:30:00.250Z', '[]'::jsonb,
       '{"machine":"rower","durationSec":1260,"distanceM":5000,"avgPowerW":182}'::jsonb),
      ('${MEMBER_A}', NULL, '2026-10-02T08:00:00Z',
       '[{"name":"Back squat","sets":[{"reps":5,"weightKg":80}]}]'::jsonb, NULL),
      ('${MEMBER_A}', NULL, '2026-09-15T23:59:59Z', '[]'::jsonb,
       '{"machine":"rower","distanceM":1}'::jsonb),
      ('${MEMBER_A}', NULL, '2026-10-16T00:00:00Z', '[]'::jsonb,
       '{"machine":"rower","distanceM":2}'::jsonb),
      ('${MEMBER_A2}', NULL, '2026-10-12T07:00:00Z', '[]'::jsonb,
       '{"machine":"treadmill","distanceM":8000}'::jsonb);
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('createDrizzleCardioProgressionRepoHttp under athlya_app', () => {
  it('runs as a NOBYPASSRLS role', async () => {
    const { rows } = await pglite.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('lists the caller sessions with a cardio summary in [from, to), newest first', async () => {
    const rows = await repo(memberA).listCardioInWindow(MEMBER_A, WINDOW);
    expect(rows).toEqual([
      {
        startedAt: '2026-10-14T07:00:00.000Z',
        cardio: {
          machine: 'indoorBike',
          durationSec: 3600,
          distanceM: 30000,
          energyKcal: 700,
          avgPowerW: 200,
          avgHeartRateBpm: 150,
        },
      },
      {
        startedAt: '2026-10-13T07:00:00.000Z',
        cardio: { machine: 'indoorBike', durationSec: 900, distanceM: 6000, avgPowerW: 100 },
      },
      {
        startedAt: '2026-10-01T18:30:00.250Z',
        cardio: { machine: 'rower', durationSec: 1260, distanceM: 5000, avgPowerW: 182 },
      },
    ]);
  });

  it('honours the row limit', async () => {
    const rows = await repo(memberA).listCardioInWindow(MEMBER_A, { ...WINDOW, limit: 1 });
    expect(rows.map((r) => r.startedAt)).toEqual(['2026-10-14T07:00:00.000Z']);
  });

  it("hides another member's sessions even when asked by user id, and from an admin", async () => {
    expect(await repo(memberA2).listCardioInWindow(MEMBER_A, WINDOW)).toEqual([]);
    expect(await repo(adminA).listCardioInWindow(MEMBER_A, WINDOW)).toEqual([]);
    const own = await repo(memberA2).listCardioInWindow(MEMBER_A2, WINDOW);
    expect(own.map((r) => r.cardio)).toEqual([{ machine: 'treadmill', distanceM: 8000 }]);
  });

  it('feeds the use case end to end into a schema-valid weekly series', async () => {
    const result = await getCardioProgression(MEMBER_A, 30, 'week', {
      repo: repo(memberA),
      now: () => NOW,
    });
    expect(CardioProgressionResponseSchema.parse(result)).toEqual(result);
    expect(result.totals).toEqual({
      sessions: 3,
      durationSec: 5_760,
      distanceM: 41_000,
      energyKcal: 700,
    });
    expect(result.machines.map((m) => m.machine)).toEqual(['indoorBike', 'rower']);
    expect(result.machines[0]?.series.at(-1)).toEqual({
      periodStart: '2026-10-12',
      sessions: 2,
      durationSec: 4_500,
      distanceM: 36_000,
      energyKcal: 700,
      avgPowerW: 180,
      avgHeartRateBpm: 150,
    });
    expect(result.skippedSessions).toBe(0);
  });
});
