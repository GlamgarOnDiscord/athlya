/**
 * Unit tests for the RGPD maintenance jobs (Sprint-2 Slices 2.2 +
 * 2.3, audit findings S5-004 + S5-005 + S5-006).
 *
 * Strategy
 * --------
 * Every public function in `maintenance/rgpd-purge.ts` accepts a
 * minimal `SqlExecutor` contract (`execute(query, params)`) so we
 * can drive the whole behaviour through a recording fake. The
 * tests assert:
 *
 *   1. The right SQL is issued (substring match on the salient
 *      clauses — `users SET email = NULL`, `DELETE FROM outbox`,
 *      etc. — so a refactor that preserves semantics passes).
 *   2. The params list carries the cutoff date computed from the
 *      injected clock minus the configured window.
 *   3. The returned counts match what the executor reports.
 *   4. Idempotency / batching options are respected.
 *
 * @see packages/api/src/maintenance/rgpd-purge.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_EXPORT_JOBS_RETENTION_DAYS,
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_USER_ANONYMIZE_AFTER_DAYS,
  anonymizeExpiredUsers,
  purgeExpiredExportJobs,
  purgeExpiredOutbox,
  runRgpdMaintenanceCycle,
} from '../maintenance/rgpd-purge.js';

import type { PurgeClock, SqlExecutor } from '../maintenance/rgpd-purge.js';

/* ------------------------------------------------------------------ */
/*  Fake executor                                                      */
/* ------------------------------------------------------------------ */

class RecordingExecutor implements SqlExecutor {
  readonly calls: { query: string; params: readonly unknown[] }[] = [];
  /**
   * Either a static row count returned by every call, or a per-
   * call queue. The queue mode lets tests simulate
   * "first call returns 200, second returns 50" patterns.
   */
  rowCounts: number[] = [];
  /** Override to make a specific call throw. */
  throwOnCall: number | null = null;

  async execute(query: string, params: readonly unknown[]): Promise<number> {
    const callIndex = this.calls.length;
    this.calls.push({ query, params });
    if (this.throwOnCall === callIndex) {
      throw new Error('simulated postgres failure');
    }
    return this.rowCounts.shift() ?? 0;
  }
}

function fixedClock(iso: string): PurgeClock {
  return { now: () => new Date(iso) };
}

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== */
/*  S5-004 — anonymizeExpiredUsers                                     */
/* ================================================================== */

describe('anonymizeExpiredUsers (S5-004)', () => {
  it('issues a CTE-bound UPDATE that strips PII fields', async () => {
    const exec = new RecordingExecutor();
    exec.rowCounts = [3];
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    const result = await anonymizeExpiredUsers(exec, { clock });

    expect(result.anonymizedCount).toBe(3);
    expect(exec.calls).toHaveLength(1);
    const query = exec.calls[0]!.query;
    expect(query).toContain('UPDATE users');
    expect(query).toContain('email = NULL');
    expect(query).toContain("display_name = '[deleted]'");
    expect(query).toContain('avatar_url = NULL');
    expect(query).toContain("consents = '{}'::jsonb");
    expect(query).toContain('password_hash = NULL');
    // Idempotency guard — the WHERE filters on `email IS NOT NULL`
    // so a second pass against the same row is a no-op.
    expect(query).toContain('email IS NOT NULL');
  });

  it('passes a cutoff date 30 days before the clock by default', async () => {
    const exec = new RecordingExecutor();
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    await anonymizeExpiredUsers(exec, { clock });

    const [cutoff, limit] = exec.calls[0]!.params as [Date, number];
    const expected = new Date(
      new Date('2026-05-15T12:00:00.000Z').getTime() -
        DEFAULT_USER_ANONYMIZE_AFTER_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(cutoff.toISOString()).toBe(expected.toISOString());
    expect(limit).toBe(DEFAULT_BATCH_LIMIT);
  });

  it('honours a custom anonymizeAfterDays + batchLimit', async () => {
    const exec = new RecordingExecutor();
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    await anonymizeExpiredUsers(exec, {
      clock,
      anonymizeAfterDays: 7,
      batchLimit: 50,
    });

    const [cutoff, limit] = exec.calls[0]!.params as [Date, number];
    const expected = new Date(
      new Date('2026-05-15T12:00:00.000Z').getTime() - 7 * 24 * 60 * 60 * 1000,
    );
    expect(cutoff.toISOString()).toBe(expected.toISOString());
    expect(limit).toBe(50);
  });
});

/* ================================================================== */
/*  S5-005 — purgeExpiredOutbox                                        */
/* ================================================================== */

describe('purgeExpiredOutbox (S5-005)', () => {
  it('deletes rows whose published_at is older than the retention window', async () => {
    const exec = new RecordingExecutor();
    exec.rowCounts = [12];
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    const result = await purgeExpiredOutbox(exec, { clock });

    expect(result.deletedCount).toBe(12);
    const query = exec.calls[0]!.query;
    expect(query).toContain('DELETE FROM outbox');
    // Critical guard: only published rows are eligible. Pending
    // rows MUST stay so the drain worker keeps retrying them.
    expect(query).toContain('published_at IS NOT NULL');
  });

  it('uses the 7-day default window', async () => {
    const exec = new RecordingExecutor();
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    await purgeExpiredOutbox(exec, { clock });

    const [cutoff] = exec.calls[0]!.params as [Date];
    const expected = new Date(
      new Date('2026-05-15T12:00:00.000Z').getTime() -
        DEFAULT_OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });
});

/* ================================================================== */
/*  S5-006 — purgeExpiredExportJobs                                    */
/* ================================================================== */

describe('purgeExpiredExportJobs (S5-006)', () => {
  it('deletes only completed/failed rows older than 90 days', async () => {
    const exec = new RecordingExecutor();
    exec.rowCounts = [5];
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    const result = await purgeExpiredExportJobs(exec, { clock });

    expect(result.deletedCount).toBe(5);
    const query = exec.calls[0]!.query;
    expect(query).toContain('DELETE FROM export_jobs');
    // Only terminal statuses are eligible — `pending` /
    // `running` rows might still be in flight on QStash and
    // their downloadable archive must remain user-facing
    // until the cron retention horizon passes.
    expect(query).toContain("status IN ('completed', 'failed')");
    const [cutoff] = exec.calls[0]!.params as [Date];
    const expected = new Date(
      new Date('2026-05-15T12:00:00.000Z').getTime() -
        DEFAULT_EXPORT_JOBS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(cutoff.toISOString()).toBe(expected.toISOString());
  });
});

/* ================================================================== */
/*  Aggregate runner                                                   */
/* ================================================================== */

describe('runRgpdMaintenanceCycle', () => {
  it('runs all three jobs sequentially and aggregates counts', async () => {
    const exec = new RecordingExecutor();
    exec.rowCounts = [3, 12, 5];
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    const result = await runRgpdMaintenanceCycle(exec, { clock });

    expect(result.anonymizedUsers).toBe(3);
    expect(result.purgedOutbox).toBe(12);
    expect(result.purgedExportJobs).toBe(5);
    expect(exec.calls).toHaveLength(3);
    // Order is intentional — anonymise first (smallest blast
    // radius), then outbox, then export_jobs.
    expect(exec.calls[0]!.query).toContain('UPDATE users');
    expect(exec.calls[1]!.query).toContain('DELETE FROM outbox');
    expect(exec.calls[2]!.query).toContain('DELETE FROM export_jobs');
  });

  it('continues running remaining jobs after one fails, then throws aggregate error', async () => {
    const exec = new RecordingExecutor();
    // Anonymise call (index 0) throws; outbox + export_jobs
    // must still execute. The aggregate error reports the
    // first failure verbatim.
    exec.throwOnCall = 0;
    exec.rowCounts = [0, 12, 5];
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    await expect(runRgpdMaintenanceCycle(exec, { clock })).rejects.toThrow(
      /rgpd maintenance cycle.*simulated postgres failure/,
    );

    // Both remaining jobs must have been attempted.
    expect(exec.calls).toHaveLength(3);
    expect(exec.calls[1]!.query).toContain('DELETE FROM outbox');
    expect(exec.calls[2]!.query).toContain('DELETE FROM export_jobs');
  });

  it('returns 0 counts on a quiet system (no rows to clean)', async () => {
    const exec = new RecordingExecutor();
    // Default rowCount is 0 when the queue is empty.
    const clock = fixedClock('2026-05-15T12:00:00.000Z');

    const result = await runRgpdMaintenanceCycle(exec, { clock });

    expect(result).toEqual({
      anonymizedUsers: 0,
      purgedOutbox: 0,
      purgedExportJobs: 0,
    });
  });
});
