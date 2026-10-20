import { describe, expect, it, vi } from 'vitest';

import {
  HOLD_SWEEP_LIMIT,
  runScheduledCapacityReconcile,
} from '../maintenance/capacity-reconcile-runner.js';

import type { CapacityReconcileSqlExecutor } from '../maintenance/capacity-reconcile-runner.js';
import type { CapacityHealer } from '@athlya/reservations/reconcile';

function counterStub(
  remaining: number | null,
): CapacityHealer & { compareAndSet: ReturnType<typeof vi.fn> } {
  return {
    inspectRemaining: vi.fn(async () => remaining),
    compareAndSet: vi.fn(async () => true),
  };
}

describe('runScheduledCapacityReconcile', () => {
  it('selects active classes and heals drift via the counter', async () => {
    let capturedSql = '';
    const executeSql: CapacityReconcileSqlExecutor = {
      async selectRows<T>(query: string): Promise<T[]> {
        capturedSql = query;
        return [{ classId: 'c1', capacity: 20, confirmed: 18 }] as unknown as T[];
      },
    };
    const counter = counterStub(9);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runScheduledCapacityReconcile({ executeSql, counter });

    // Issue #117 — athlya_cron has no grant on classes / reservations:
    // the read goes through the cron-only SECURITY DEFINER function.
    expect(capturedSql).toContain('FROM capacity_reconcile_snapshot()');
    expect(capturedSql).not.toMatch(/\bfrom\s+(classes|reservations)\b/iu);
    expect(result).toMatchObject({ checked: 1, drifted: 1, healed: 1 });
    expect(counter.compareAndSet).toHaveBeenCalledWith('c1', 9, 2);
    vi.restoreAllMocks();
  });

  it('returns skipped (never throws) when the SQL read fails', async () => {
    const executeSql: CapacityReconcileSqlExecutor = {
      selectRows<T>(): Promise<T[]> {
        return Promise.reject(new Error('neon down'));
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runScheduledCapacityReconcile({ executeSql, counter: counterStub(0) });

    expect(result).toMatchObject({ skipped: true, reason: 'neon down' });
    vi.restoreAllMocks();
  });

  it('sweeps holds and the waitlist first, through the cron-only function', async () => {
    const calls: { query: string; params: readonly unknown[] }[] = [];
    const executeSql: CapacityReconcileSqlExecutor = {
      async selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]> {
        calls.push({ query, params });
        return (query.includes('reservation_sweep_holds_and_promote')
          ? [{ expiredHolds: 2, promotedWaiters: 1, promotedClasses: 1 }]
          : [{ classId: 'c1', capacity: 20, confirmed: 18 }]) as unknown as T[];
      },
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runScheduledCapacityReconcile({ executeSql, counter: counterStub(2), logger });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain('FROM reservation_sweep_holds_and_promote($1)');
    expect(calls[0]?.query).not.toMatch(/\bfrom\s+(classes|reservations)\b/iu);
    expect(calls[0]?.params).toEqual([HOLD_SWEEP_LIMIT]);
    expect(calls[1]?.query).toContain('FROM capacity_reconcile_snapshot()');
    expect(logger.info).toHaveBeenCalledWith('capacity reconcile: hold and waitlist sweep', {
      expiredHolds: 2,
      promotedWaiters: 1,
      promotedClasses: 1,
    });
  });

  it('still heals the counter when the sweep fails', async () => {
    const executeSql: CapacityReconcileSqlExecutor = {
      async selectRows<T>(query: string): Promise<T[]> {
        if (query.includes('reservation_sweep_holds_and_promote')) {
          throw new Error('function does not exist');
        }
        return [{ classId: 'c1', capacity: 20, confirmed: 18 }] as unknown as T[];
      },
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const counter = counterStub(9);

    const result = await runScheduledCapacityReconcile({ executeSql, counter, logger });

    expect(logger.error).toHaveBeenCalledWith('capacity reconcile: hold sweep failed', {
      error: 'function does not exist',
    });
    expect(result).toMatchObject({ checked: 1, healed: 1 });
    expect(counter.compareAndSet).toHaveBeenCalledWith('c1', 9, 2);
  });
});
