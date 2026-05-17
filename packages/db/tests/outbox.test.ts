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
  claimBatch,
  InvalidOutboxInputError,
  insertOutbox,
  markFailed,
  markPublished,
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
      EVENT.occurredAt,
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
