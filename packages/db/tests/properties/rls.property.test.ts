/**
 * Tenant isolation via the Drizzle client — Property 7 (task 2.7).
 *
 * **Validates: Requirements 13.2, 13.3, 13.5**
 *
 * Requirement 13.5 mandates that any authenticated read for a resource
 * belonging to another studio MUST return zero rows, which the API
 * layer (task 8.3) then renders as HTTP 404 so cross-tenant resource
 * existence is not disclosed. Requirement 13.2 restricts `users`
 * reads to the caller's own row or the same-studio slice (admin/coach
 * only); Requirement 13.3 restricts `reservations` reads to rows
 * owned by the caller. Together these form the tenant-isolation
 * invariant this property asserts.
 *
 * The property:
 *
 *   ∀ disjoint studios A, B with rows owned by each,
 *     ∀ role ∈ {member, coach, admin},
 *       withTenant({ userId: userA, studioId: studioA, role }, tx =>
 *         tx.select().from(<table>).where(<eq to B-owned id>)
 *       ).length === 0
 *
 * "Disjoint" means the studio / user / class / reservation ids drawn
 * for A and B do not collide. `fc.pre()` rejects the ~0-probability
 * cases where uuidv4 happens to produce a collision.
 *
 * Mechanics:
 *   1. A single Postgres 17 container is spun up in `beforeAll` via
 *      `@testcontainers/postgresql`. We apply `0000_init.sql` and
 *      `0001_rls.sql` against it, then create a dedicated
 *      `athlya_tenant` LOGIN role that is NOBYPASSRLS — this is the
 *      connection `withTenant` runs through. Superusers bypass RLS
 *      regardless of `FORCE ROW LEVEL SECURITY`, so running the
 *      assertions under the default `postgres` role would produce
 *      false positives. See `tests/rls/00_bootstrap.sql` for the
 *      pgTAP equivalent.
 *   2. Each fast-check sample truncates the five relevant tables and
 *      re-seeds two studios, two users, two classes, two reservations
 *      (via the superuser client, which *does* bypass RLS so we can
 *      insert without matching INSERT policies). Then the property
 *      asks the tenant-role client to look up the B-owned row while
 *      scoped to tenant A and asserts zero rows came back.
 *   3. `numRuns: 25` — every run is a full DB round-trip so we cannot
 *      afford the 100+ runs used by in-memory property suites. 25 is
 *      enough to catch any cross-tenant leak that isn't purely
 *      structural (structural leaks would show up after 1 run; 25
 *      gives us coverage across the three target tables × three roles).
 *   4. When Docker is not reachable the whole suite self-skips. The
 *      detection is a synchronous `docker info` probe at module load
 *      so `describe.skipIf` can see the flag before it registers
 *      tests. This keeps `pnpm --filter @athlya/db test` green on
 *      machines without a running Docker daemon; CI must ensure the
 *      daemon is up so the suite actually executes.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDbFromClient,
  withTenant,
  classes,
  reservations,
  users,
  type AthlyaDb,
  type TenantClaims,
  type TenantRole,
} from '../../src/index.js';
import * as schema from '../../src/schema/index.js';

import {
  DEFAULT_CONSENTS_JSON,
  isolationScenarioArb,
  scenarioIdsAllDistinct,
  type IsolationScenario,
} from './fixtures.js';

import type { PgliteAthlyaDb } from '../helpers/pglite-test-db.js';
import type { PGlite } from '@electric-sql/pglite';
import type { Sql } from 'postgres';

// ---------------------------------------------------------------------
// Docker-daemon availability probe
//
// Testcontainers tries to open a connection to the Docker daemon when
// `PostgreSqlContainer#start()` runs; the failure mode on a machine
// without a running daemon is an opaque ECONNREFUSED that fires 15–60 s
// later. A synchronous `docker info` probe at module load lets us
// short-circuit that: when Docker is unreachable we use
// `describe.skipIf(!dockerReady)` and the whole suite is recorded as
// skipped rather than as a hang.
// ---------------------------------------------------------------------

function detectDocker(): boolean {
  try {
    const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      encoding: 'utf8',
    });
    return res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const dockerReady = detectDocker();

// ---------------------------------------------------------------------
// Shared state — populated by `beforeAll`, consumed by the property.
// The two clients live at module scope so each fast-check sample
// reuses the same connection pool rather than paying the 30 s
// container-startup tax per run.
// ---------------------------------------------------------------------

let container: { stop: () => Promise<void> } | null = null;

/** Superuser connection used for schema + seed operations. */
let rootClient: Sql | null = null;

/** Non-superuser connection used for the tenant-scoped assertions. */
let tenantClient: Sql | null = null;

/** Drizzle handle wrapping the tenant-role `tenantClient`. */
let tenantDb: AthlyaDb | null = null;

const ROOT_ROLE = 'postgres';
const TENANT_ROLE = 'athlya_tenant';
const TENANT_PASSWORD = 'tenant_test';

// PGlite state — populated in beforeAll when Docker is unreachable (CN.9.3).
let pgliteHandle: PGlite | null = null;
let pgliteDb: PgliteAthlyaDb | null = null;

// ---------------------------------------------------------------------
// Migration application
//
// `postgres-js` speaks the extended query protocol by default, which
// refuses multi-statement strings. drizzle-kit emits a
// `--> statement-breakpoint` marker between statements; we split on
// that marker and send each fragment individually via `sql.unsafe()`
// with prepared statements disabled. The fragments that use
// `DO $$ ... $$` blocks or `CREATE OR REPLACE FUNCTION ... $$ ... $$`
// are delivered as a single string to `unsafe()`, which re-parses them
// server-side.
// ---------------------------------------------------------------------

async function applyMigration(client: Sql, sqlText: string, connStr?: string): Promise<void> {
  if (/\bCONCURRENTLY\b/i.test(sqlText) && connStr) {
    const dedicated = postgres(connStr, { max: 1, prepare: false });
    try {
      await dedicated.unsafe(sqlText);
    } finally {
      await dedicated.end({ timeout: 5 });
    }
  } else {
    const statements = sqlText
      .split(/-->\s*statement-breakpoint/g)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    for (const stmt of statements) {
      await client.unsafe(stmt);
    }
  }
}

/**
 * Locates `packages/db/migrations/<name>` relative to this test file so
 * the suite works whether vitest is invoked from the package or the
 * monorepo root.
 */
function readMigration(name: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const file = resolve(here, '..', '..', 'migrations', name);
  return readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------
// Tenant-role bootstrap
//
// `createDb`'s ONLY job is to SET LOCAL the three `app.*` session
// variables. For the policies to actually filter rows we must connect
// through a role that is NOT superuser and does NOT have BYPASSRLS.
// We create a LOGIN role, grant it the minimum DML rights to every
// RLS-protected table, and open a second `postgres-js` client bound
// to its credentials. The superuser `rootClient` stays available for
// seed / truncate operations which bypass RLS.
// ---------------------------------------------------------------------

async function bootstrapTenantRole(client: Sql): Promise<void> {
  await client.unsafe(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TENANT_ROLE}') THEN
                CREATE ROLE ${TENANT_ROLE} LOGIN PASSWORD '${TENANT_PASSWORD}' NOBYPASSRLS;
            END IF;
        END$$;
        GRANT USAGE ON SCHEMA public TO ${TENANT_ROLE};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TENANT_ROLE};
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TENANT_ROLE};
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${TENANT_ROLE};
    `);
}

// ---------------------------------------------------------------------
// Seeding (runs as superuser, so every INSERT is accepted regardless
// of per-table INSERT policies).
// ---------------------------------------------------------------------

async function truncateAll(client: Sql): Promise<void> {
  await client.unsafe(`
        TRUNCATE TABLE
            "push_tokens",
            "idempotency_keys",
            "outbox",
            "audit_log",
            "workout_sessions",
            "reservations",
            "classes",
            "users",
            "studios"
        RESTART IDENTITY CASCADE
    `);
}

async function seedScenario(client: Sql, s: IsolationScenario): Promise<void> {
  const consents = JSON.stringify(DEFAULT_CONSENTS_JSON);

  // Studios
  await client`
        INSERT INTO "studios" (id, slug, name, brand_color)
        VALUES
            (${s.studioA.id}, ${s.studioA.slug}, ${s.studioA.name}, '#0EA5E9'),
            (${s.studioB.id}, ${s.studioB.slug}, ${s.studioB.name}, '#F97316')
    `;

  // Users — email is citext so the INSERT tolerates arbitrary case.
  await client`
        INSERT INTO "users" (id, studio_id, email, display_name, role, consents)
        VALUES
            (
                ${s.userA.id},
                ${s.userA.studioId},
                ${s.userA.email},
                ${s.userA.displayName},
                ${s.userA.role},
                ${consents}::jsonb
            ),
            (
                ${s.userB.id},
                ${s.userB.studioId},
                ${s.userB.email},
                ${s.userB.displayName},
                ${s.userB.role},
                ${consents}::jsonb
            )
    `;

  // Classes
  await client`
        INSERT INTO "classes" (id, studio_id, title, starts_at, duration_min, capacity, version)
        VALUES
            (
                ${s.classA.id},
                ${s.classA.studioId},
                ${s.classA.title},
                ${s.classA.startsAt}::timestamptz,
                ${s.classA.durationMin},
                ${s.classA.capacity},
                0
            ),
            (
                ${s.classB.id},
                ${s.classB.studioId},
                ${s.classB.title},
                ${s.classB.startsAt}::timestamptz,
                ${s.classB.durationMin},
                ${s.classB.capacity},
                0
            )
    `;

  // Reservations — each reservation belongs to the matching studio's
  // user and class, so the anti-double-booking UNIQUE(class_id,
  // user_id) index is satisfied by construction.
  await client`
        INSERT INTO "reservations" (id, class_id, user_id, status)
        VALUES
            (${s.reservationA.id}, ${s.reservationA.classId}, ${s.reservationA.userId}, 'confirmed'),
            (${s.reservationB.id}, ${s.reservationB.classId}, ${s.reservationB.userId}, 'confirmed')
    `;
}

// ---------------------------------------------------------------------
// Per-scenario assertions
// ---------------------------------------------------------------------

interface IsolationResult {
  readonly userBVisible: boolean;
  readonly classBVisible: boolean;
  readonly reservationBVisible: boolean;
  readonly userASelfVisible: boolean;
}

async function queryIsolation(
  db: AthlyaDb,
  s: IsolationScenario,
  role: TenantRole,
): Promise<IsolationResult> {
  const claims: TenantClaims = {
    userId: s.userA.id,
    studioId: s.studioA.id,
    role,
  };

  return withTenant(db, claims, async (tx) => {
    // 1. Query user B by id — expected to return [] across every
    //    role because userB.studio_id ≠ studioA.
    const userBRows = await tx.select().from(users).where(eq(users.id, s.userB.id));

    // 2. Query class B by id — studio_id on the row differs from
    //    app.studio_id, so `classes_read_same_studio` filters it.
    const classBRows = await tx.select().from(classes).where(eq(classes.id, s.classB.id));

    // 3. Query reservation B by id — reservations_read_own rejects
    //    (user_id ≠ app.user_id) and reservations_read_admin_same_studio
    //    rejects because the reservation's class belongs to B.
    const reservationBRows = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, s.reservationB.id));

    // 4. Sanity check — user A must still see their OWN row.
    //    Without this the property could be trivially satisfied
    //    by a policy that denies every read. Getting a positive
    //    signal on the owner's side confirms RLS is active AND
    //    correctly scoped.
    const userASelfRows = await tx.select().from(users).where(eq(users.id, s.userA.id));

    return {
      userBVisible: userBRows.length > 0,
      classBVisible: classBRows.length > 0,
      reservationBVisible: reservationBRows.length > 0,
      userASelfVisible: userASelfRows.length > 0,
    };
  });
}

// -----------------------------------------------------------------
// PGlite helpers — used when Docker is unreachable (CN.9.3).
// A single superuser connection is sufficient because `SET LOCAL
// ROLE athlya_tenant` inside each transaction drops BYPASSRLS for
// the duration of that transaction, enforcing RLS exactly as the
// two-connection Docker path does.
// -----------------------------------------------------------------

async function truncateAllPglite(pg: PGlite): Promise<void> {
  await pg.exec(`
    TRUNCATE TABLE
        push_tokens,
        idempotency_keys,
        outbox,
        audit_log,
        workout_sessions,
        reservations,
        classes,
        users,
        studios
    RESTART IDENTITY CASCADE
  `);
}

async function seedScenarioPglite(pg: PGlite, s: IsolationScenario): Promise<void> {
  const consents = JSON.stringify(DEFAULT_CONSENTS_JSON);
  await pg.query(
    `INSERT INTO studios (id, slug, name, brand_color) VALUES ($1, $2, $3, '#0EA5E9')`,
    [s.studioA.id, s.studioA.slug, s.studioA.name],
  );
  await pg.query(
    `INSERT INTO studios (id, slug, name, brand_color) VALUES ($1, $2, $3, '#F97316')`,
    [s.studioB.id, s.studioB.slug, s.studioB.name],
  );
  await pg.query(
    `INSERT INTO users (id, studio_id, email, display_name, role, consents) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [s.userA.id, s.userA.studioId, s.userA.email, s.userA.displayName, s.userA.role, consents],
  );
  await pg.query(
    `INSERT INTO users (id, studio_id, email, display_name, role, consents) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [s.userB.id, s.userB.studioId, s.userB.email, s.userB.displayName, s.userB.role, consents],
  );
  await pg.query(
    `INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES ($1, $2, $3, $4::timestamptz, $5, $6, 0)`,
    [
      s.classA.id,
      s.classA.studioId,
      s.classA.title,
      s.classA.startsAt,
      s.classA.durationMin,
      s.classA.capacity,
    ],
  );
  await pg.query(
    `INSERT INTO classes (id, studio_id, title, starts_at, duration_min, capacity, version) VALUES ($1, $2, $3, $4::timestamptz, $5, $6, 0)`,
    [
      s.classB.id,
      s.classB.studioId,
      s.classB.title,
      s.classB.startsAt,
      s.classB.durationMin,
      s.classB.capacity,
    ],
  );
  await pg.query(
    `INSERT INTO reservations (id, class_id, user_id, status) VALUES ($1, $2, $3, 'confirmed')`,
    [s.reservationA.id, s.reservationA.classId, s.reservationA.userId],
  );
  await pg.query(
    `INSERT INTO reservations (id, class_id, user_id, status) VALUES ($1, $2, $3, 'confirmed')`,
    [s.reservationB.id, s.reservationB.classId, s.reservationB.userId],
  );
}

async function withTenantPglite<T>(
  db: PgliteAthlyaDb,
  claims: TenantClaims,
  fn: (tx: Parameters<Parameters<PgliteAthlyaDb['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${TENANT_ROLE}`));
    await tx.execute(sql`SELECT set_config('app.user_id', ${claims.userId}, true)`);
    await tx.execute(sql`SELECT set_config('app.studio_id', ${claims.studioId}, true)`);
    await tx.execute(sql`SELECT set_config('app.role', ${claims.role}, true)`);
    return fn(tx);
  });
}

async function queryIsolationPglite(
  db: PgliteAthlyaDb,
  s: IsolationScenario,
  role: TenantRole,
): Promise<IsolationResult> {
  return withTenantPglite(db, { userId: s.userA.id, studioId: s.studioA.id, role }, async (tx) => {
    const userBRows = await tx.select().from(users).where(eq(users.id, s.userB.id));
    const classBRows = await tx.select().from(classes).where(eq(classes.id, s.classB.id));
    const reservationBRows = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, s.reservationB.id));
    const userASelfRows = await tx.select().from(users).where(eq(users.id, s.userA.id));
    return {
      userBVisible: userBRows.length > 0,
      classBVisible: classBRows.length > 0,
      reservationBVisible: reservationBRows.length > 0,
      userASelfVisible: userASelfRows.length > 0,
    };
  });
}

interface TestInfra {
  truncate(): Promise<void>;
  seed(s: IsolationScenario): Promise<void>;
  query(s: IsolationScenario, role: TenantRole): Promise<IsolationResult>;
}

function buildInfra(): TestInfra {
  if (rootClient !== null && tenantDb !== null) {
    const root = rootClient;
    const db = tenantDb;
    return {
      truncate: () => truncateAll(root),
      seed: (s) => seedScenario(root, s),
      query: (s, role) => queryIsolation(db, s, role),
    };
  }
  if (pgliteHandle !== null && pgliteDb !== null) {
    const pg = pgliteHandle;
    const db = pgliteDb;
    return {
      truncate: () => truncateAllPglite(pg),
      seed: (s) => seedScenarioPglite(pg, s),
      query: (s, role) => queryIsolationPglite(db, s, role),
    };
  }
  throw new Error('test infrastructure not initialised');
}

// ---------------------------------------------------------------------
// Vitest lifecycle
// ---------------------------------------------------------------------

beforeAll(async () => {
  if (!dockerReady) {
    // PGlite fallback (CN.9.3) — real PostgreSQL WASM; supports RLS,
    // PL/pgSQL, set_config() and SET LOCAL ROLE so the tenant-isolation
    // property runs without Docker on Windows / CI-light machines.
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');
    const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');

    const pg = new PGlite({ extensions: { pgcrypto, citext } });

    await pg.exec(readMigration('0000_init.sql'));
    await pg.exec(readMigration('0001_rls.sql'));
    await pg.exec(readMigration('0007_classes_fts.sql'));

    // Bootstrap the NOBYPASSRLS tenant role + grant the superuser the
    // right to switch into it via SET LOCAL ROLE inside transactions.
    await pg.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TENANT_ROLE}') THEN
          CREATE ROLE ${TENANT_ROLE} LOGIN PASSWORD '${TENANT_PASSWORD}' NOBYPASSRLS;
        END IF;
      END$$;
      GRANT USAGE ON SCHEMA public TO ${TENANT_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TENANT_ROLE};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TENANT_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${TENANT_ROLE};
      GRANT ${TENANT_ROLE} TO postgres;
    `);

    pgliteHandle = pg;
    pgliteDb = drizzlePglite(pg, { schema });
    return;
  }

  // Dynamic import so the module is only resolved when we actually
  // need it. Keeps `pnpm test` on no-docker machines from failing on
  // an unresolved `@testcontainers/postgresql` import if the dep is
  // absent (e.g. fresh clone before `pnpm install`).
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

  // The default image is `postgres:15-alpine`; the Athlya spec pins
  // Postgres 17, so we override explicitly. The init-db user stays
  // `postgres` (superuser) because we need it to run the migrations.
  const started = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('athlya_test')
    .withUsername(ROOT_ROLE)
    .withPassword('root_test')
    .start();

  container = {
    stop: async () => {
      await started.stop();
    },
  };
  const rootConnString = started.getConnectionUri();

  rootClient = postgres(rootConnString, { max: 2, prepare: false });

  // Apply schema + RLS.
  await applyMigration(rootClient, readMigration('0000_init.sql'), rootConnString);
  await applyMigration(rootClient, readMigration('0001_rls.sql'), rootConnString);
  await applyMigration(rootClient, readMigration('0007_classes_fts.sql'), rootConnString);

  // Create the NOBYPASSRLS tenant role + grants.
  await bootstrapTenantRole(rootClient);

  // Open a second client bound to that role. The connection URI
  // exposed by Testcontainers already points at the mapped host
  // port; we just swap the user and password.
  const tenantUri = buildTenantUri(started.getHost(), started.getMappedPort(5432));
  tenantClient = postgres(tenantUri, { max: 4, prepare: false });
  tenantDb = createDbFromClient(tenantClient);
}, 180_000);

afterAll(async () => {
  try {
    await tenantClient?.end({ timeout: 5 });
    await rootClient?.end({ timeout: 5 });
    await pgliteHandle?.close();
  } finally {
    await container?.stop();
  }
});

function buildTenantUri(host: string, port: number): string {
  // `postgres-js` accepts the standard libpq URL format. Using a
  // URL constructor guarantees correct encoding of the password.
  const u = new URL('postgres://placeholder');
  u.hostname = host;
  u.port = String(port);
  u.username = TENANT_ROLE;
  u.password = TENANT_PASSWORD;
  u.pathname = '/athlya_test';
  return u.toString();
}

// ---------------------------------------------------------------------
// Property 7 — always registered. Uses Docker (Testcontainers) when
// available; falls back to PGlite (in-memory PostgreSQL WASM) on machines
// without Docker (e.g. Windows local dev).
// ---------------------------------------------------------------------

describe('withTenant — Property 7 (tenant isolation)', () => {
  const ROLES: readonly TenantRole[] = ['member', 'coach', 'admin'];

  for (const role of ROLES) {
    it(`cross-tenant reads return [] for role=${role} across users/classes/reservations`, async () => {
      const infra = buildInfra();

      await fc.assert(
        fc.asyncProperty(isolationScenarioArb, async (scenario) => {
          fc.pre(scenarioIdsAllDistinct(scenario));

          await infra.truncate();
          await infra.seed(scenario);

          const result = await infra.query(scenario, role);

          return (
            result.userBVisible === false &&
            result.classBVisible === false &&
            result.reservationBVisible === false &&
            result.userASelfVisible === true
          );
        }),
        { numRuns: 25, seed: 0x7e4a1d3b },
      );
    }, 180_000);
  }

  // Non-property smoke test covering the happy path. Keeps the file
  // self-contained so a maintainer can eyeball a single legible
  // scenario before reading the property block above.
  it('admin of studio A cannot see any row owned by studio B', async () => {
    const infra = buildInfra();
    const scenario: IsolationScenario = {
      studioA: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        slug: 'alpha',
        name: 'Alpha',
      },
      studioB: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        slug: 'bravo',
        name: 'Bravo',
      },
      userA: {
        id: '11111111-1111-4111-8111-111111111111',
        studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        email: 'a@athlya.test',
        displayName: 'User A',
        role: 'admin',
      },
      userB: {
        id: '22222222-2222-4222-8222-222222222222',
        studioId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        email: 'b@athlya.test',
        displayName: 'User B',
        role: 'member',
      },
      classA: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
        studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        title: 'Class A',
        startsAt: '2030-01-01T09:00:00Z',
        durationMin: 60,
        capacity: 20,
      },
      classB: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
        studioId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        title: 'Class B',
        startsAt: '2030-01-01T19:00:00Z',
        durationMin: 45,
        capacity: 15,
      },
      reservationA: {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
        classId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
        userId: '11111111-1111-4111-8111-111111111111',
      },
      reservationB: {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddd02',
        classId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
        userId: '22222222-2222-4222-8222-222222222222',
      },
    };

    await infra.truncate();
    await infra.seed(scenario);

    const result = await infra.query(scenario, 'admin');

    expect(result.userBVisible).toBe(false);
    expect(result.classBVisible).toBe(false);
    expect(result.reservationBVisible).toBe(false);
    expect(result.userASelfVisible).toBe(true);
  });
});

// Always-registered anchor so the test file reports *something* in
// environments without Docker. Otherwise `vitest run --reporter=verbose`
// would show an empty file and CI could miss a broken import.
describe('rls property suite registration', () => {
  it('imports the tenant-isolation fixtures without error', () => {
    // Touching the arbitrary forces fast-check and the fixtures
    // module to load — a broken import would surface here rather
    // than only inside the docker-gated suite.
    expect(typeof isolationScenarioArb).toBe('object');
  });

  it.skipIf(dockerReady)('logs a clear message when Docker is unavailable', () => {
    // A green record of the skip; CI dashboards that filter by
    // "skipped" will surface this on machines where RLS is not
    // exercised.
    expect(dockerReady).toBe(false);
  });
});
