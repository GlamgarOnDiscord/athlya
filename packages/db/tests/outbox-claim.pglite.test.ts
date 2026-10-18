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

  // PGlite runs on one connection, so the two claims below execute one after
  // the other: this checks the lease filter (a second drain skips rows the
  // first one leased), not a row-lock race between two connections.
  it('does not hand rows leased by one drain to a second drain (issue #311)', async () => {
    await handle.pglite.exec(`
      INSERT INTO outbox (event_id, event_type, payload, occurred_at)
      SELECT 'evt-burst-' || g, 'reservation.reminder', '{}', now() - make_interval(secs => g)
        FROM generate_series(1, 40) g;
    `);
    const compliance = ['auth.user.deleted'];

    const [kick, cron] = await Promise.all([
      claimLeasedBatch(db, 25, 120, compliance),
      claimLeasedBatch(db, 25, 120, compliance),
    ]);
    const again = await claimLeasedBatch(db, 25, 120, compliance);

    const kickIds = kick.map((r) => r.eventId);
    const cronIds = cron.map((r) => r.eventId);
    expect(kickIds.filter((id) => cronIds.includes(id))).toEqual([]);
    // 43 claimable rows (40 + 3 seeded, the 4th is under a live lease):
    // the two drains split them, and a third claim finds nothing left.
    expect(kick.length + cron.length).toBe(43);
    expect([...kickIds, ...cronIds]).not.toContain('evt-leased');
    expect(again).toEqual([]);
  });

  it('is plain FIFO without priority types', async () => {
    const rows = await claimLeasedBatch(db, 1, 120);

    expect(rows.map((r) => r.eventId)).toEqual(['evt-notif-old']);
  });
});
