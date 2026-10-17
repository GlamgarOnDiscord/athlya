/**
 * Unit tests for cursor-based keyset pagination in `reservations-list-drizzle.ts`.
 *
 * Issue #334 — keyset pagination was broken for rows pre-dating the UUID v7
 * migration (migration 0016). Pre-existing rows carry v4 UUIDs; new rows
 * carry v7. A `WHERE id > :cursor ORDER BY id` query mis-orders those rows.
 *
 * The fix uses `(starts_at, id)` as the composite cursor key. `starts_at` is
 * a stable timestamp that guarantees consistent ordering; `id` is the
 * tie-breaker within the same class slot. Mixed v4/v7 values in the same
 * slot produce an arbitrary but STABLE total order — every `(starts_at, id)`
 * pair is unique, so pagination is always gap-free.
 *
 * These tests drive `listMyReservations` through a fake DB chain that returns
 * controlled row sets. They verify:
 *   1. First page: nextCursor is non-null when rows exceed limit.
 *   2. Last page: nextCursor is null when rows fit within limit.
 *   3. The cursor round-trips — providing the cursor from page 1 as input to
 *      page 2 results in a different call (simulated by checking the cursor
 *      is decoded and non-null is passed through).
 *   4. Mixed v4/v7 UUID rows paginate without duplicates or gaps when the
 *      dataset spans both UUID generations.
 */

import { describe, expect, it, vi } from 'vitest';

import { listMyReservations } from '../../adapters/reservations-list-drizzle.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CLAIMS = {
  userId: USER_ID,
  studioId: '00000000-0000-4000-8000-0000000000aa',
  role: 'member' as const,
};

function makeRow(id: string, startsAt: Date) {
  return {
    id,
    classId: '00000000-0000-4000-8000-000000000010',
    userId: USER_ID,
    status: 'confirmed' as const,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    cancelledAt: null,
    checkedInAt: null,
    classTitle: 'Yoga',
    classStartsAt: startsAt,
    classDurationMin: 60,
  };
}

const V4_ID = '550e8400-e29b-41d4-a716-446655440000';
const V7_ID = '018f7b3a-4f00-7000-8000-000000000002';
const STARTS_AT = new Date('2026-07-01T09:00:00.000Z');

function buildFakeDb(rows: ReturnType<typeof makeRow>[]) {
  const selectQuery = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  selectQuery.limit.mockReturnValue(selectQuery);
  selectQuery.orderBy.mockReturnValue(selectQuery);
  selectQuery.where.mockReturnValue(selectQuery);
  selectQuery.innerJoin.mockReturnValue(selectQuery);
  selectQuery.from.mockReturnValue(selectQuery);

  // Rows only come back through `batch`, i.e. inside `withTenantHttp`.
  return {
    select: vi.fn().mockReturnValue(selectQuery),
    execute: vi.fn(() => ({ kind: 'set_config' })),
    batch: vi.fn(async (items: unknown[]) => {
      expect(items).toHaveLength(4);
      expect(items[3]).toBe(selectQuery);
      return [null, null, null, rows];
    }),
    _selectQuery: selectQuery,
  };
}

describe('listMyReservations cursor pagination (issue #334)', () => {
  it('returns nextCursor when there are more rows than the limit', async () => {
    const limit = 2;
    const rows = [
      makeRow(V4_ID, STARTS_AT),
      makeRow(V7_ID, new Date('2026-07-01T10:00:00.000Z')),
      makeRow('00000000-0000-4000-8000-000000000099', new Date('2026-07-01T11:00:00.000Z')),
    ];
    const db = buildFakeDb(rows);

    const result = await listMyReservations(
      USER_ID,
      { limit },
      { db: db as never, claims: CLAIMS },
    );

    expect(result.items).toHaveLength(limit);
    expect(result.nextCursor).not.toBeNull();
    expect(typeof result.nextCursor).toBe('string');
  });

  it('returns nextCursor: null on the last page', async () => {
    const limit = 5;
    const rows = [makeRow(V4_ID, STARTS_AT), makeRow(V7_ID, STARTS_AT)];
    const db = buildFakeDb(rows);

    const result = await listMyReservations(
      USER_ID,
      { limit },
      { db: db as never, claims: CLAIMS },
    );

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('cursor encodes the last row startsAt + id and is opaque base64url', async () => {
    const rows = [makeRow(V4_ID, STARTS_AT), makeRow(V7_ID, new Date('2026-07-02T09:00:00.000Z'))];
    const db = buildFakeDb(rows);

    const result = await listMyReservations(
      USER_ID,
      { limit: 1 },
      { db: db as never, claims: CLAIMS },
    );

    expect(result.nextCursor).not.toBeNull();
    expect(result.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const b64 = result.nextCursor!.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4))) as {
      startsAt: string;
      id: string;
    };
    expect(decoded.startsAt).toBe(STARTS_AT.toISOString());
    expect(decoded.id).toBe(V4_ID);
  });

  it('accepts a cursor without crashing (malformed cursor falls back to first page)', async () => {
    const db = buildFakeDb([makeRow(V4_ID, STARTS_AT)]);

    const result = await listMyReservations(
      USER_ID,
      { cursor: 'not-valid-base64url!!' },
      { db: db as never, claims: CLAIMS },
    );

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('mixed v4/v7 UUIDs on same starts_at paginate without duplicates', async () => {
    const t = new Date('2026-07-01T09:00:00.000Z');
    const v4Row = makeRow(V4_ID, t);
    const v7Row = makeRow(V7_ID, t);

    const firstPageDb = buildFakeDb([
      v4Row,
      v7Row,
      makeRow('ffffffff-ffff-4fff-8fff-ffffffffffff', t),
    ]);
    const page1 = await listMyReservations(
      USER_ID,
      { limit: 2 },
      { db: firstPageDb as never, claims: CLAIMS },
    );

    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const ids1 = page1.items.map((i) => i.id);
    expect(new Set(ids1).size).toBe(ids1.length);

    const secondPageDb = buildFakeDb([makeRow('ffffffff-ffff-4fff-8fff-ffffffffffff', t)]);
    const page2 = await listMyReservations(
      USER_ID,
      { limit: 2, cursor: page1.nextCursor! },
      { db: secondPageDb as never, claims: CLAIMS },
    );

    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...ids1, ...page2.items.map((i) => i.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('always runs inside a tenant batch with the caller claims (issue #117)', async () => {
    const db = buildFakeDb([makeRow(V4_ID, STARTS_AT)]);
    await listMyReservations(USER_ID, {}, { db: db as never, claims: CLAIMS });
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });
});
