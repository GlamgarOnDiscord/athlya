/**
 * Unit tests for the transactional-outbox helpers.
 *
 * These tests mirror `idempotency.test.ts`: a fake drizzle transaction
 * captures every `sql\`\`` statement emitted by the helper so we can
 * assert on the SQL shape (table name, `FOR UPDATE SKIP LOCKED`,
 * ordering, `ON CONFLICT`) without standing up Postgres. Property
 * tests against a Testcontainers-backed database belong to the
 * integration suite added by task 9.4.
 *
 * Related requirements: 16.1, 16.2, 16.3, 16.4.
 */

import { describe, expect, it } from 'vitest';

import {
  claimLeasedBatch,
  markPublishedMany,
  claimBatch,
  countPendingOutbox,
  InvalidOutboxInputError,
  insertOutbox,
  markFailed,
  markPublished,
  releaseLeases,
  type OutboxEvent,
} from '../src/outbox.js';

import { makeFakeTx } from './_sql-capture.js';

const EVENT: OutboxEvent = {
  eventId: 'evt_018f3c11-4e2d-7b53',
  eventType: 'reservation.created',
  payload: { reservationId: 'res-1', classId: 'cls-1', userId: 'usr-1' },
  occurredAt: new Date('2025-06-01T10:00:00.000Z'),
};

const OUTBOX_ROW_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';

describe('insertOutbox', () => {
  it('inserts with publishedAt=null and attempts=0', async () => {
    const { tx, calls } = makeFakeTx();

    await insertOutbox(tx, EVENT);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.sqlText).toMatch(/insert\s+into\s+outbox/i);
    // `NULL` and `0` are inlined in the VALUES clause because they
    // are compile-time constants — the drain worker's invariants
    // depend on them, so we assert on the literal SQL.
    expect(call?.sqlText).toMatch(/NULL\s*,\s*0\s*\)/);
  });

  it('is idempotent on eventId via ON CONFLICT DO NOTHING', async () => {
    const { tx, calls } = makeFakeTx();

    await insertOutbox(tx, EVENT);

    const call = calls[0];
    expect(call?.sqlText).toMatch(/on\s+conflict\s*\(\s*event_id\s*\)\s*do\s+nothing/i);
  });

  it('binds eventId, eventType, serialised payload and occurredAt as parameters', async () => {
    const { tx, calls } = makeFakeTx();

    await insertOutbox(tx, EVENT);

    const call = calls[0];
    expect(call?.params).toEqual([
      EVENT.eventId,
      EVENT.eventType,
      JSON.stringify(EVENT.payload),
      EVENT.occurredAt.toISOString(),
    ]);
  });

  it('casts the payload to jsonb', async () => {
    const { tx, calls } = makeFakeTx();

    await insertOutbox(tx, EVENT);

    expect(calls[0]?.sqlText).toMatch(/::jsonb/i);
  });

  it('rejects an event with an empty eventId', async () => {
    const { tx, execute } = makeFakeTx();
    await expect(insertOutbox(tx, { ...EVENT, eventId: '' })).rejects.toBeInstanceOf(
      InvalidOutboxInputError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an event with an invalid occurredAt', async () => {
    const { tx, execute } = makeFakeTx();
    await expect(
      insertOutbox(tx, {
        ...EVENT,
        occurredAt: new Date('not-a-date'),
      }),
    ).rejects.toBeInstanceOf(InvalidOutboxInputError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('claimBatch', () => {
  it('selects pending rows ordered by occurred_at ASC with SKIP LOCKED', async () => {
    const { tx, calls } = makeFakeTx();

    await claimBatch(tx, 25);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    // Only pending rows are eligible.
    expect(call?.sqlText).toMatch(/where\s+published_at\s+is\s+null/i);
    // FIFO ordering by occurrence.
    expect(call?.sqlText).toMatch(/order\s+by\s+occurred_at\s+asc/i);
    // Cooperative concurrency: parallel drain workers skip locked rows.
    expect(call?.sqlText).toMatch(/for\s+update\s+skip\s+locked/i);
    // Bumped `attempts` in the same statement so a crash between
    // claim and publish still records the attempt.
    expect(call?.sqlText).toMatch(/set\s+attempts\s*=\s*outbox\.attempts\s*\+\s*1/i);
  });

  it('binds the limit as a parameter', async () => {
    const { tx, calls } = makeFakeTx();
    await claimBatch(tx, 25);
    expect(calls[0]?.params).toEqual([25]);
  });

  it('defaults the limit to 50', async () => {
    const { tx, calls } = makeFakeTx();
    await claimBatch(tx);
    expect(calls[0]?.params).toEqual([50]);
  });

  it('maps wire column names onto the typed shape', async () => {
    const { tx, enqueueResult } = makeFakeTx();
    const occurredAt = new Date('2025-06-01T10:00:00.000Z');
    enqueueResult([
      {
        id: OUTBOX_ROW_ID,
        event_id: EVENT.eventId,
        event_type: EVENT.eventType,
        payload: EVENT.payload,
        occurred_at: occurredAt,
        attempts: 1,
      },
    ]);

    const rows = await claimBatch(tx, 10);

    expect(rows).toEqual([
      {
        id: OUTBOX_ROW_ID,
        eventId: EVENT.eventId,
        eventType: EVENT.eventType,
        payload: EVENT.payload,
        occurredAt,
        attempts: 1,
      },
    ]);
  });

  it('returns an empty array when no rows are pending', async () => {
    const { tx, enqueueResult } = makeFakeTx();
    enqueueResult([]);
    const rows = await claimBatch(tx);
    expect(rows).toEqual([]);
  });

  it('rejects a non-positive limit', async () => {
    const { tx, execute } = makeFakeTx();
    await expect(claimBatch(tx, 0)).rejects.toBeInstanceOf(InvalidOutboxInputError);
    await expect(claimBatch(tx, -5)).rejects.toBeInstanceOf(InvalidOutboxInputError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an oversized limit to protect against pathological drain loops', async () => {
    const { tx } = makeFakeTx();
    await expect(claimBatch(tx, 100_000)).rejects.toBeInstanceOf(InvalidOutboxInputError);
  });
});

describe('countPendingOutbox', () => {
  it('counts unpublished rows and returns the oldest occurred_at', async () => {
    const { tx, enqueueResult } = makeFakeTx();
    const oldest = new Date('2025-06-01T09:00:00.000Z');
    enqueueResult([{ pending: 3, oldest_occurred_at: oldest }]);

    const snapshot = await countPendingOutbox(tx);

    expect(snapshot.pending).toBe(3);
    expect(snapshot.oldestOccurredAt).toEqual(oldest);
  });

  it('returns zero pending when the table has no unpublished rows', async () => {
    const { tx, enqueueResult } = makeFakeTx();
    enqueueResult([{ pending: 0, oldest_occurred_at: null }]);

    const snapshot = await countPendingOutbox(tx);

    expect(snapshot).toEqual({ pending: 0, oldestOccurredAt: null });
  });
});

describe('markPublished', () => {
  it('stamps published_at = now() for the given id', async () => {
    const { tx, calls } = makeFakeTx();

    await markPublished(tx, OUTBOX_ROW_ID);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.sqlText).toMatch(/update\s+outbox/i);
    expect(call?.sqlText).toMatch(/set\s+published_at\s*=\s*now\(\)/i);
    expect(call?.sqlText).toMatch(/where\s+id\s*=/i);
    expect(call?.params).toEqual([OUTBOX_ROW_ID]);
  });

  it('rejects a non-UUID id', async () => {
    const { tx, execute } = makeFakeTx();
    await expect(markPublished(tx, 'not-a-uuid')).rejects.toBeInstanceOf(InvalidOutboxInputError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('markFailed', () => {
  it('is a no-op at the SQL level (attempts already bumped by claimBatch)', async () => {
    const { tx, execute } = makeFakeTx();

    await markFailed(tx, OUTBOX_ROW_ID);

    expect(execute).not.toHaveBeenCalled();
  });

  it('still validates the id shape', async () => {
    const { tx } = makeFakeTx();
    await expect(markFailed(tx, 'not-a-uuid')).rejects.toBeInstanceOf(InvalidOutboxInputError);
  });
});

describe('releaseLeases', () => {
  const LEASE = '2026-10-17 12:00:00.123456+00';

  it('undoes the claim attempt and only touches rows still under this lease', async () => {
    const { tx, calls } = makeFakeTx();

    await releaseLeases(tx, [OUTBOX_ROW_ID], LEASE);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.sqlText).toMatch(/set\s+lease_until\s*=\s*null/i);
    expect(call?.sqlText).toMatch(/attempts\s*=\s*greatest\(outbox\.attempts\s*-\s*1,\s*0\)/i);
    expect(call?.sqlText).toMatch(/published_at\s+is\s+null/i);
    expect(call?.sqlText).toMatch(/lease_until\s*=\s*\?::timestamptz/i);
    expect(call?.params).toEqual([`{${OUTBOX_ROW_ID}}`, LEASE]);
  });

  it('is a no-op for an empty id list', async () => {
    const { tx, execute } = makeFakeTx();
    await releaseLeases(tx, [], LEASE);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('claimLeasedBatch (issues #424 / #311)', () => {
  it('claims unleased rows, stamps a lease and ranks priority types first', async () => {
    const { tx, calls } = makeFakeTx();

    await claimLeasedBatch(tx, 50, 120, ['auth.user.deleted']);

    const call = calls[0];
    expect(call?.sqlText).toMatch(/lease_until\s+is\s+null\s+or\s+lease_until\s*<=\s*now\(\)/i);
    expect(call?.sqlText).toMatch(/for\s+update\s+skip\s+locked/i);
    expect(call?.sqlText).toMatch(/lease_until\s*=\s*now\(\)\s*\+\s*make_interval/i);
    expect(call?.sqlText).toMatch(
      /order\s+by\s+\(event_type\s*=\s*any\(\?::text\[\]\)\)\s+desc,\s*occurred_at\s+asc/i,
    );
    expect(call?.sqlText).toMatch(/lease_until::text\s+as\s+lease_token/i);
    expect(call?.params).toEqual(['{auth.user.deleted}', 50, 120]);
  });

  it.each(["auth.user.deleted'); drop table outbox; --", 'Auth.User', 'single'])(
    'rejects the priority type %j',
    async (eventType) => {
      const { tx, execute } = makeFakeTx();
      await expect(claimLeasedBatch(tx, 50, 120, [eventType])).rejects.toBeInstanceOf(
        InvalidOutboxInputError,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('maps the text occurred_at drizzle passes through onto a Date', async () => {
    const { tx, enqueueResult } = makeFakeTx();
    enqueueResult([
      {
        id: OUTBOX_ROW_ID,
        event_id: EVENT.eventId,
        event_type: 'auth.password_reset.requested',
        payload: { userId: 'usr-1' },
        occurred_at: '2026-10-18 14:30:00.123456+00',
        attempts: 1,
        studio_id: null,
        lease_token: '2026-10-18 14:32:00.123456+00',
      },
    ]);

    const [row] = await claimLeasedBatch(tx, 10, 120);

    expect(row?.occurredAt).toBeInstanceOf(Date);
    expect(row?.occurredAt.toISOString()).toBe('2026-10-18T14:30:00.123Z');
    expect(row?.leaseToken).toBe('2026-10-18 14:32:00.123456+00');
  });

  it.each([0, 3601, 1.5])('rejects a lease of %s seconds', async (lease) => {
    const { tx, execute } = makeFakeTx();
    await expect(claimLeasedBatch(tx, 50, lease)).rejects.toBeInstanceOf(InvalidOutboxInputError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('markPublishedMany', () => {
  it('stamps every id in one statement and clears the lease', async () => {
    const { tx, calls } = makeFakeTx();
    await markPublishedMany(tx, [OUTBOX_ROW_ID]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sqlText).toMatch(
      /set\s+published_at\s*=\s*now\(\),\s*lease_until\s*=\s*null/i,
    );
    expect(calls[0]?.params).toEqual([`{${OUTBOX_ROW_ID}}`]);
  });

  it('is a no-op for an empty batch and rejects non-UUID ids', async () => {
    const { tx, execute } = makeFakeTx();
    await markPublishedMany(tx, []);
    expect(execute).not.toHaveBeenCalled();
    await expect(markPublishedMany(tx, ['nope'])).rejects.toBeInstanceOf(InvalidOutboxInputError);
  });
});
