/**
 * Studio settings and webhook adapters under the real `athlya_app` role,
 * on PGlite with every forward migration (issues #759, #760), and the
 * outbox trigger that records deliveries.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '@athlya/db/schema';
import { PGlite } from '@electric-sql/pglite';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWebhooksRepo } from '../../adapters/webhooks-deps.js';
import { MAX_WEBHOOK_ENDPOINTS, newWebhookSecret } from '../../routes/webhooks.js';

import type { AuthClaims } from '../../middleware/auth.js';
import type { AthlyaDb } from '@athlya/db/client';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../../db/migrations');

const STUDIO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STUDIO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN_A = '11111111-1111-4111-8111-1111111aaaaa';
const COACH_A = '11111111-1111-4111-8111-11111111c0ac';
const ADMIN_B = '22222222-2222-4222-8222-2222222aaaaa';

const adminA: AuthClaims = { userId: ADMIN_A, studioId: STUDIO_A, role: 'admin' };
const coachA: AuthClaims = { userId: COACH_A, studioId: STUDIO_A, role: 'coach' };
const adminB: AuthClaims = { userId: ADMIN_B, studioId: STUDIO_B, role: 'admin' };

let pglite: PGlite;
let db: AthlyaDb;

beforeAll(async () => {
  pglite = new PGlite({ extensions: { btree_gin, citext, pgcrypto } });
  const forward = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const file of forward) {
    const body = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pglite.exec(body.replace(/\bCONCURRENTLY\b/gu, ''));
  }
  await pglite.exec(`
    INSERT INTO studios (id, slug, name) VALUES
      ('${STUDIO_A}', 'studio-a', 'Studio A'),
      ('${STUDIO_B}', 'studio-b', 'Studio B');
    INSERT INTO users (id, studio_id, email, display_name, role, consents)
    SELECT id::uuid, studio::uuid, email, name, role::user_role,
           '{"marketing":false,"analytics":false,"thirdParty":false,"version":"2026-01","updatedAt":"2026-01-01T00:00:00Z"}'::jsonb
      FROM (VALUES
        ('${ADMIN_A}', '${STUDIO_A}', 'admin-a@test.dev', 'Admin A', 'admin'),
        ('${COACH_A}', '${STUDIO_A}', 'coach-a@test.dev', 'Coach A', 'coach'),
        ('${ADMIN_B}', '${STUDIO_B}', 'admin-b@test.dev', 'Admin B', 'admin')
      ) AS seed (id, studio, email, name, role);
    SET ROLE athlya_app;
  `);
  db = drizzle(pglite, { schema }) as unknown as AthlyaDb;
}, 120_000);

afterAll(async () => {
  await pglite.close();
});

describe('webhooks adapter under athlya_app', () => {
  it('registers an endpoint for the admin, lists it without its secret, and hides it elsewhere', async () => {
    const repo = createWebhooksRepo(db);
    const endpoint = await repo.createEndpoint(adminA, {
      url: 'https://hooks.example-a.fr/athlya',
      events: ['reservation.created', 'reservation.cancelled'],
      secret: newWebhookSecret(),
    });

    expect(endpoint).toMatchObject({
      url: 'https://hooks.example-a.fr/athlya',
      events: ['reservation.created', 'reservation.cancelled'],
      enabled: true,
      recentDeliveries: [],
    });
    expect(JSON.stringify(await repo.listEndpoints(adminA))).not.toContain('whsec_');
    expect(await repo.listEndpoints(adminB)).toEqual([]);
    await expect(repo.listEndpoints(coachA)).resolves.toEqual([]);
  });

  it('records a delivery when the studio publishes a subscribed event, shown on the endpoint', async () => {
    await pglite.exec(`
      RESET ROLE;
      INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id) VALUES
        ('evt-a-1', 'reservation.created', '{"reservationId":"r1"}', now(), '${STUDIO_A}'),
        ('evt-a-2', 'reservation.promoted', '{"reservationId":"r2"}', now(), '${STUDIO_A}'),
        ('evt-b-1', 'reservation.created', '{"reservationId":"r3"}', now(), '${STUDIO_B}');
      SET ROLE athlya_app;
    `);

    const [endpoint] = await createWebhooksRepo(db).listEndpoints(adminA);
    expect(endpoint?.recentDeliveries.map((d) => [d.eventId, d.status])).toEqual([
      ['evt-a-1', 'pending'],
    ]);
  });

  it('updates, rotates and deletes within the studio only', async () => {
    const repo = createWebhooksRepo(db);
    const [endpoint] = await repo.listEndpoints(adminA);
    if (endpoint === undefined) throw new Error('endpoint missing');

    expect(await repo.updateEndpoint(adminB, endpoint.id, { enabled: false })).toBeNull();
    expect(await repo.updateEndpoint(adminA, endpoint.id, { enabled: false })).toMatchObject({
      enabled: false,
    });
    expect(
      await repo.updateEndpoint(adminA, endpoint.id, { secret: newWebhookSecret() }),
    ).toMatchObject({ id: endpoint.id });
    expect(await repo.deleteEndpoint(adminB, endpoint.id)).toBe(false);
    expect(await repo.deleteEndpoint(adminA, endpoint.id)).toBe(true);
    expect(await repo.listEndpoints(adminA)).toEqual([]);
  });

  it('stops at the endpoint limit of the studio', async () => {
    const repo = createWebhooksRepo(db);
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS; i += 1) {
      await repo.createEndpoint(adminB, {
        url: `https://hooks.example-b.fr/${i}`,
        events: ['auth.user.registered'],
        secret: newWebhookSecret(),
      });
    }
    expect(
      await repo.createEndpoint(adminB, {
        url: 'https://hooks.example-b.fr/one-more',
        events: ['auth.user.registered'],
        secret: newWebhookSecret(),
      }),
    ).toBeNull();
  });
});
