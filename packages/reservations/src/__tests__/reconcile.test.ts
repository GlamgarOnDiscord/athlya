import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CAPACITY_DRIFT_LOG_MESSAGE,
  CAPACITY_DRIFT_METRIC,
  reconcileCapacityDrift,
  type CapacityHealer,
  type CapacityReconcileRepo,
  type ClassCapacitySnapshot,
} from '../reconcile.js';

function repoOf(rows: ClassCapacitySnapshot[]): CapacityReconcileRepo {
  return { listActiveClassCapacities: vi.fn().mockResolvedValue(rows) };
}

function healerOf(remaining: Record<string, number | null>): CapacityHealer & {
  reset: ReturnType<typeof vi.fn>;
} {
  return {
    getRemaining: vi.fn(async (id: string) => remaining[id] ?? null),
    reset: vi.fn(async () => undefined),
  };
}

describe('reconcileCapacityDrift', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a no-op when Redis matches PG (expected = capacity - confirmed)', async () => {
    const repo = repoOf([{ classId: 'c1', capacity: 20, confirmed: 5 }]);
    const counter = healerOf({ c1: 15 });

    const report = await reconcileCapacityDrift({ repo, counter });

    expect(report).toMatchObject({ checked: 1, drifted: 0, healed: 0, seeded: 0 });
    expect(counter.reset).not.toHaveBeenCalled();
  });

  it('seeds a missing Redis key from PG without flagging drift', async () => {
    const repo = repoOf([{ classId: 'c1', capacity: 20, confirmed: 8 }]);
    const counter = healerOf({ c1: null });

    const report = await reconcileCapacityDrift({ repo, counter });

    expect(report).toMatchObject({ seeded: 1, drifted: 0 });
    expect(counter.reset).toHaveBeenCalledWith('c1', 12);
  });

  it('detects oversell drift (Redis too high) and auto-heals to PG truth', async () => {
    const repo = repoOf([{ classId: 'c1', capacity: 20, confirmed: 18 }]);
    const counter = healerOf({ c1: 9 }); // expected 2, Redis says 9 → oversell risk
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const report = await reconcileCapacityDrift({ repo, counter });

    expect(report).toMatchObject({ drifted: 1, healed: 1 });
    expect(report.drifts[0]).toMatchObject({
      classId: 'c1',
      redisRemaining: 9,
      expectedRemaining: 2,
      drift: 7,
      healed: true,
    });
    expect(counter.reset).toHaveBeenCalledWith('c1', 2);
    expect(warn).toHaveBeenCalledWith(
      CAPACITY_DRIFT_LOG_MESSAGE,
      expect.objectContaining({ metric: CAPACITY_DRIFT_METRIC, direction: 'oversell_risk' }),
    );
  });

  it('detects false-full drift (Redis too low) and tags direction', async () => {
    const repo = repoOf([{ classId: 'c1', capacity: 20, confirmed: 5 }]);
    const counter = healerOf({ c1: 0 }); // expected 15, Redis says 0 → false full
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const report = await reconcileCapacityDrift({ repo, counter });

    expect(report.drifts[0]).toMatchObject({ drift: -15, healed: true });
    expect(counter.reset).toHaveBeenCalledWith('c1', 15);
    expect(warn).toHaveBeenCalledWith(
      CAPACITY_DRIFT_LOG_MESSAGE,
      expect.objectContaining({ direction: 'false_full' }),
    );
  });

  it('clamps expected at 0 when confirmed exceeds capacity', async () => {
    const repo = repoOf([{ classId: 'c1', capacity: 10, confirmed: 12 }]);
    const counter = healerOf({ c1: -2 });

    const report = await reconcileCapacityDrift({ repo, counter });

    // expected = max(0, 10 - 12) = 0; Redis -2 → drift -2, heal to 0
    expect(report).toMatchObject({ drifted: 1, healed: 1 });
    expect(counter.reset).toHaveBeenCalledWith('c1', 0);
  });

  it('does not reset when autoHeal is false', async () => {
    const repo = repoOf([{ classId: 'c1', capacity: 20, confirmed: 18 }]);
    const counter = healerOf({ c1: 9 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const report = await reconcileCapacityDrift({ repo, counter, autoHeal: false });

    expect(report).toMatchObject({ drifted: 1, healed: 0 });
    expect(report.drifts[0]?.healed).toBe(false);
    expect(counter.reset).not.toHaveBeenCalled();
  });

  it('isolates per-class failures and keeps sweeping', async () => {
    const repo = repoOf([
      { classId: 'bad', capacity: 20, confirmed: 1 },
      { classId: 'good', capacity: 20, confirmed: 1 },
    ]);
    const counter: CapacityHealer = {
      getRemaining: vi.fn(async (id: string) =>
        id === 'bad' ? Promise.reject(new Error('redis down')) : 19,
      ),
      reset: vi.fn(async () => undefined),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await reconcileCapacityDrift({ repo, counter });

    expect(report).toMatchObject({ checked: 2, healFailures: 1, drifted: 0 });
  });

  it('counts heal failures when reset throws', async () => {
    const repo = repoOf([{ classId: 'c1', capacity: 20, confirmed: 18 }]);
    const counter: CapacityHealer = {
      getRemaining: vi.fn(async () => 9),
      reset: vi.fn(async () => Promise.reject(new Error('reset boom'))),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await reconcileCapacityDrift({ repo, counter });

    expect(report).toMatchObject({ drifted: 1, healed: 0, healFailures: 1 });
    expect(report.drifts[0]?.healed).toBe(false);
  });
});
