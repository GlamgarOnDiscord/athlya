import { describe, expect, it, vi } from 'vitest';

import { runScheduledCapacityReconcile } from '../maintenance/capacity-reconcile-runner.js';

import type { CapacityReconcileSqlExecutor } from '../maintenance/capacity-reconcile-runner.js';
import type { CapacityHealer } from '@athlya/reservations/reconcile';

function counterStub(remaining: number | null): CapacityHealer & { reset: ReturnType<typeof vi.fn> } {
  return {
    getRemaining: vi.fn(async () => remaining),
    reset: vi.fn(async () => undefined),
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

    expect(capturedSql).toContain("status = 'confirmed'");
    expect(capturedSql).toContain('starts_at > now()');
    expect(result).toMatchObject({ checked: 1, drifted: 1, healed: 1 });
    expect(counter.reset).toHaveBeenCalledWith('c1', 2);
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
});
