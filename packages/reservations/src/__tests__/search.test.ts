/**
 * Unit tests for the class full-text search use case (`searchClasses`) — CN.8.2.
 *
 * Exercises the main branches of {@link ../search.ts}:
 *   - Happy path: rows from the repo are mapped to `ClassSearchResult`
 *     items with ISO-8601 timestamps and Redis-backed `remaining`.
 *   - Empty result: repo returns [] → use case returns [] without
 *     touching the counter (no wasted Redis round-trips).
 *   - Counter miss: `null` from the counter falls back to `row.capacity`.
 *   - Negative counter clamp: transient negative value clamped at 0.
 *   - Null description: passed through as `null` in the result.
 *   - Date range: forwarded to the repo verbatim.
 *
 * The repo and counter are `vi.fn()` doubles — no Drizzle or Redis.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  searchClasses,
  type ClassSearchRepo,
  type ClassSearchRow,
  type SearchClassesDeps,
} from '../search.js';

import type { RemainingCounterReader } from '../counter.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const CLASS_ID_A = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8a1';
const CLASS_ID_B = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8a2';

function makeRow(overrides: Partial<ClassSearchRow> = {}): ClassSearchRow {
  return {
    id: CLASS_ID_A,
    studioId: STUDIO_ID,
    coachId: null,
    title: 'HIIT 6:30',
    description: 'High-intensity interval training',
    startsAt: new Date('2026-06-01T06:30:00.000Z'),
    durationMin: 45,
    capacity: 20,
    version: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildDeps(): {
  deps: SearchClassesDeps;
  search: ReturnType<typeof vi.fn<ClassSearchRepo['search']>>;
  getRemaining: ReturnType<typeof vi.fn<RemainingCounterReader['getRemaining']>>;
} {
  const search = vi.fn<ClassSearchRepo['search']>();
  const getRemaining = vi.fn<RemainingCounterReader['getRemaining']>();
  const deps: SearchClassesDeps = {
    searchRepo: { search },
    counter: { getRemaining },
  };
  return { deps, search, getRemaining };
}

/* ------------------------------------------------------------------ */
/*  Happy path                                                         */
/* ------------------------------------------------------------------ */

describe('searchClasses — happy path', () => {
  it('maps rows to ClassSearchResult with ISO strings and remaining', async () => {
    const rowA = makeRow({ id: CLASS_ID_A, title: 'HIIT 6:30', capacity: 20 });
    const rowB = makeRow({ id: CLASS_ID_B, title: 'Yoga 18:00', description: null, capacity: 15 });

    const { deps, search, getRemaining } = buildDeps();
    search.mockResolvedValue([rowA, rowB]);
    getRemaining.mockImplementation(async (classId) => {
      if (classId === CLASS_ID_A) return 7;
      if (classId === CLASS_ID_B) return 15;
      return null;
    });

    const result = await searchClasses(STUDIO_ID, 'hiit', undefined, deps);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: CLASS_ID_A,
      title: 'HIIT 6:30',
      description: 'High-intensity interval training',
      startsAt: '2026-06-01T06:30:00.000Z',
      remaining: 7,
    });
    expect(result[1]).toMatchObject({ description: null, remaining: 15 });
  });

  it('forwards the date range to the repo', async () => {
    const { deps, search, getRemaining } = buildDeps();
    search.mockResolvedValue([]);
    getRemaining.mockResolvedValue(null);

    const range = {
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-07-01T00:00:00.000Z'),
    };
    await searchClasses(STUDIO_ID, 'yoga', range, deps);

    expect(search).toHaveBeenCalledWith(STUDIO_ID, 'yoga', range);
  });
});

/* ------------------------------------------------------------------ */
/*  Empty result                                                       */
/* ------------------------------------------------------------------ */

describe('searchClasses — empty result', () => {
  it('returns [] without touching the counter', async () => {
    const { deps, search, getRemaining } = buildDeps();
    search.mockResolvedValue([]);

    const result = await searchClasses(STUDIO_ID, 'nonexistent', undefined, deps);

    expect(result).toStrictEqual([]);
    expect(getRemaining).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Counter fallbacks                                                  */
/* ------------------------------------------------------------------ */

describe('searchClasses — counter fallbacks', () => {
  it('falls back to capacity when the counter returns null', async () => {
    const { deps, search, getRemaining } = buildDeps();
    search.mockResolvedValue([makeRow({ capacity: 20 })]);
    getRemaining.mockResolvedValue(null);

    const [first] = await searchClasses(STUDIO_ID, 'hiit', undefined, deps);
    expect(first?.remaining).toBe(20);
  });

  it('clamps a transient negative counter value to 0', async () => {
    const { deps, search, getRemaining } = buildDeps();
    search.mockResolvedValue([makeRow()]);
    getRemaining.mockResolvedValue(-5);

    const [first] = await searchClasses(STUDIO_ID, 'hiit', undefined, deps);
    expect(first?.remaining).toBe(0);
  });
});
