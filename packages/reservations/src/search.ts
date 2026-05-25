/**
 * Full-text search use case for the Reservations service — CN.8.2.
 *
 * Searches `classes` using the PostgreSQL tsvector GIN index
 * (`classes_search_idx` on `search_vector`) introduced by migration 0007.
 * Results are scoped to the caller's studio and optionally filtered to a
 * date window.
 *
 * The module is framework-free: it depends only on a pluggable
 * {@link ClassSearchRepo} so unit tests never reach Drizzle or Postgres.
 */

import type { RemainingCounterReader } from './counter.js';
import type { ClassSearchResult } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Row shape returned by {@link ClassSearchRepo.search}. Extends the base
 * class fields with `description` surfaced by the FTS migration.
 */
export interface ClassSearchRow {
  id: string;
  studioId: string;
  coachId: string | null;
  title: string;
  description: string | null;
  startsAt: Date;
  durationMin: number;
  capacity: number;
  version: number;
  createdAt: Date;
}

export interface ClassSearchRange {
  from: Date;
  to: Date;
}

/**
 * Minimal contract for the full-text search persistence port.
 *
 * The concrete implementation in `packages/api` builds a
 * `plainto_tsquery('simple', query)` predicate against `search_vector`
 * and runs it under `withConnectionRetry`. Declared here so the service
 * owns its port and unit tests can supply a trivial double.
 */
export interface ClassSearchRepo {
  search(studioId: string, query: string, range?: ClassSearchRange): Promise<ClassSearchRow[]>;
}

/* ------------------------------------------------------------------ */
/*  Service deps                                                       */
/* ------------------------------------------------------------------ */

export interface SearchClassesDeps {
  readonly searchRepo: ClassSearchRepo;
  readonly counter: RemainingCounterReader;
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Return classes matching `query` for `studioId`, optionally filtered to
 * a `[from, to]` window.
 *
 * Flow:
 *   1. Delegate to `searchRepo.search()` — PostgreSQL resolves the
 *      tsvector query via the GIN index (`classes_search_idx`), already
 *      ordered by relevance DESC then `starts_at ASC`.
 *   2. For each result, read the remaining-seat counter from Redis. A
 *      `null` (counter not yet seeded) falls back to `row.capacity`.
 *   3. Map rows to the `ClassSearchResult` wire shape.
 *
 * No input validation is performed here — the caller (route layer) is
 * responsible for validating `query` through `SearchClassesQuerySchema`
 * before invoking this function.
 */
export async function searchClasses(
  studioId: string,
  query: string,
  range: ClassSearchRange | undefined,
  deps: SearchClassesDeps,
): Promise<ClassSearchResult[]> {
  const rows = await deps.searchRepo.search(studioId, query, range);
  if (rows.length === 0) {
    return [];
  }

  const remainings = await Promise.all(
    rows.map(async (row) => {
      const remote = await deps.counter.getRemaining(row.id);
      return remote ?? row.capacity;
    }),
  );

  return rows.map((row, index) => ({
    id: row.id,
    studioId: row.studioId,
    coachId: row.coachId,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt.toISOString(),
    durationMin: row.durationMin,
    capacity: row.capacity,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    remaining: Math.max(0, remainings[index] ?? row.capacity),
  })) as ClassSearchResult[];
}
