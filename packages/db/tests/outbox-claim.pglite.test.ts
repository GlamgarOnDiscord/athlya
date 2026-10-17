/**
 * Runs the production `claimLeasedBatch` statement against a real
 * Postgres engine (PGlite) so the compliance-first ordering (issue #311)
 * and the lease filter (issue #424) are checked on the SQL itself, not
 * on a copy of it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { claimLeasedBatch } from '../src/outbox.js';

import { createPgliteTestDb, type PgliteTestHandle } from './helpers/pglite-test-db.js';

import type { AthlyaDb } from '../src/client.js';

let handle: PgliteTestHandle;
let db: AthlyaDb;

beforeAll(async () => {
  handle = await createPgliteTestDb(['0000_init.sql', '0035_outbox_lease.sql']);
  await handle.pglite.exec('ALTER TABLE outbox ADD COLUMN IF NOT EXISTS studio_id uuid');
  // postgres-js resolves `execute` to the row array; PGlite wraps it in
  // `{ rows }`. Adapt the shape so the helper runs unchanged.
  db = {
    execute: async (query: Parameters<typeof handle.db.execute>[0]) =>
      (await handle.db.execute(query)).rows,
  } as unknown as AthlyaDb;
}, 60_000);

afterAll(async () => {
  await handle.teardown();
});

beforeEach(async () => {
  await handle.pglite.exec(`
    TRUNCATE outbox;
    INSERT INTO outbox (event_id, event_type, payload, occurred_at, lease_until) VALUES
      ('evt-notif-old', 'reservation.created', '{}', now() - interval '1 hour', NULL),
      ('evt-notif-new', 'reservation.cancelled', '{}', now() - interval '30 minutes', NULL),
      ('evt-erasure', 'auth.user.deleted', '{}', now(), NULL),
      ('evt-leased', 'auth.user.deleted', '{}', now() - interval '2 hours',
       now() + interval '1 minute');
  `);
});

describe('claimLeasedBatch on Postgres (issues #311 / #424)', () => {
  it('claims a newer compliance event before an older notification backlog', async () => {
    const rows = await claimLeasedBatch(db, 1, 120, ['auth.user.deleted']);

    expect(rows.map((r) => r.eventId)).toEqual(['evt-erasure']);
    expect(rows[0]?.attempts).toBe(1);
  });

  it('falls back to FIFO after the priority rows and skips live leases', async () => {
    const rows = await claimLeasedBatch(db, 10, 120, ['auth.user.deleted']);

    expect(rows.map((r) => r.eventId).sort()).toEqual(
      ['evt-erasure', 'evt-notif-new', 'evt-notif-old'].sort(),
    );
    const leased = await handle.pglite.query<{ event_id: string }>(
      `SELECT event_id FROM outbox WHERE lease_until > now() ORDER BY event_id`,
    );
    expect(leased.rows.map((r) => r.event_id)).toEqual([
      'evt-erasure',
      'evt-leased',
      'evt-notif-new',
      'evt-notif-old',
    ]);
  });

  it('is plain FIFO without priority types', async () => {
    const rows = await claimLeasedBatch(db, 1, 120);

    expect(rows.map((r) => r.eventId)).toEqual(['evt-notif-old']);
  });
});
