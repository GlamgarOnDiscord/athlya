import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADAPTIVE_BATCH_SIZE,
  DRAIN_MAX_ROUNDS,
  emitOutboxLaneMetrics,
  totalSnapshot,
  DRAIN_CYCLE_DEADLINE_MS,
  DRAIN_LEASE_SECONDS,
  DRAIN_SEND_CONCURRENCY,
  KICK_DRAIN_DEADLINE_MS,
  KICK_DRAIN_MAX_ROUNDS,
  MAX_DRAIN_BATCH_SIZE,
  OUTBOX_BACKLOG_BATCH_THRESHOLD,
  OUTBOX_DRAIN_OVERLAP_WARN_MS,
  emitOutboxBacklogMetric,
  emitOutboxDrainErrorsMetric,
  drainCycleCapacity,
  pickBatchSize,
  resolveConfiguredBatchSize,
  resolveDrainBatchSize,
  runKickDrain,
  runScheduledDrain,
  warnOnDrainOverlapRisk,
} from '../events/drain-scheduled.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_QUEUE_SEND_TIMEOUT_MS,
  type DrainResult,
} from '../events/drain-worker.js';
import { COMPLIANCE_EVENT_TYPES } from '../events/route-queue.js';

const countPendingOutboxMock = vi.hoisted(() => vi.fn());
const claimBatchMock = vi.hoisted(() => vi.fn());
const markPublishedMock = vi.hoisted(() => vi.fn());
const releaseLeasesMock = vi.hoisted(() => vi.fn());
const countByTypeMock = vi.hoisted(() => vi.fn());

vi.mock('@athlya/db/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@athlya/db/outbox')>();
  return {
    ...actual,
    countPendingOutbox: countPendingOutboxMock,
    countPendingOutboxByType: countByTypeMock,
    claimLeasedBatch: claimBatchMock,
    markPublishedMany: markPublishedMock,
    releaseLeases: releaseLeasesMock,
  };
});

describe('resolveDrainBatchSize', () => {
  it('honours env.batchSize override', async () => {
    const size = await resolveDrainBatchSize({} as never, {
      getDb: vi.fn(),
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
      batchSize: 42,
    });
    expect(size).toBe(42);
    expect(countPendingOutboxMock).not.toHaveBeenCalled();
  });

  it('uses adaptive batch size when pending exceeds threshold', async () => {
    countPendingOutboxMock.mockResolvedValue({
      pending: OUTBOX_BACKLOG_BATCH_THRESHOLD + 1,
      oldestOccurredAt: null,
    });
    const size = await resolveDrainBatchSize({} as never, {
      getDb: vi.fn(),
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
    });
    expect(size).toBe(ADAPTIVE_BATCH_SIZE);
  });

  it('uses default batch size under threshold', async () => {
    countPendingOutboxMock.mockResolvedValue({ pending: 10, oldestOccurredAt: null });
    const size = await resolveDrainBatchSize({} as never, {
      getDb: vi.fn(),
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
    });
    expect(size).toBe(DEFAULT_BATCH_SIZE);
  });
});

describe('pickBatchSize', () => {
  it('returns adaptive size above threshold, default at/below', () => {
    expect(pickBatchSize(OUTBOX_BACKLOG_BATCH_THRESHOLD + 1)).toBe(ADAPTIVE_BATCH_SIZE);
    expect(pickBatchSize(OUTBOX_BACKLOG_BATCH_THRESHOLD)).toBe(DEFAULT_BATCH_SIZE);
    expect(pickBatchSize(0)).toBe(DEFAULT_BATCH_SIZE);
  });
});

describe('emitOutboxBacklogMetric', () => {
  afterEach(() => vi.restoreAllMocks());

  it('always logs the outbox_pending_count metric to console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const oldest = new Date(Date.now() - 30_000);

    emitOutboxBacklogMetric({ pending: 7, oldestOccurredAt: oldest }, DEFAULT_BATCH_SIZE);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'outbox.backlog',
        metric: 'outbox_pending_count',
        pending: 7,
        batchSize: DEFAULT_BATCH_SIZE,
        backlog: false,
        ageMs: expect.any(Number),
      }),
    );
  });

  it('flags backlog and forwards to the logger when one is wired', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.fn();

    emitOutboxBacklogMetric(
      { pending: OUTBOX_BACKLOG_BATCH_THRESHOLD + 1, oldestOccurredAt: null },
      ADAPTIVE_BATCH_SIZE,
      { info, warn: vi.fn(), error: vi.fn() },
    );

    expect(info).toHaveBeenCalledWith(
      'outbox drain: pending snapshot',
      expect.objectContaining({ backlog: true, ageMs: 0 }),
    );
  });
});

describe('runScheduledDrain', () => {
  afterEach(() => vi.restoreAllMocks());

  // Issue #424 — the drain must never open a transaction around sends.
  function fakeDb() {
    return {
      transaction: vi.fn(() => {
        throw new Error('runScheduledDrain must not open a transaction');
      }),
    } as never;
  }

  it('queries pending once per cycle and emits the backlog metric', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    countByTypeMock.mockReset().mockResolvedValue([
      {
        eventType: 'reservation.created',
        pending: OUTBOX_BACKLOG_BATCH_THRESHOLD,
        oldestOccurredAt: null,
      },
      { eventType: 'auth.user.deleted', pending: 50, oldestOccurredAt: null },
    ]);
    claimBatchMock.mockReset().mockResolvedValue([]);

    const result = await runScheduledDrain({
      getDb: () => fakeDb(),
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
    });

    expect(countByTypeMock).toHaveBeenCalledTimes(1);
    expect(claimBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      ADAPTIVE_BATCH_SIZE,
      DRAIN_LEASE_SECONDS,
      COMPLIANCE_EVENT_TYPES,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'outbox.backlog',
        metric: 'outbox_pending_count',
        backlog: true,
      }),
    );
    expect(result.processed).toBe(0);
  });

  it('skips the snapshot query when batchSize is overridden', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    countByTypeMock.mockReset();
    claimBatchMock.mockReset().mockResolvedValue([]);

    await runScheduledDrain({
      getDb: () => fakeDb(),
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
      batchSize: 25,
    });

    expect(countByTypeMock).not.toHaveBeenCalled();
    expect(claimBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      25,
      DRAIN_LEASE_SECONDS,
      COMPLIANCE_EVENT_TYPES,
    );
  });

  it('emits athlya.outbox.drain_errors when the drain reports failures', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    countByTypeMock
      .mockReset()
      .mockResolvedValue([{ eventType: 'member.registered', pending: 5, oldestOccurredAt: null }]);

    const failingRow = {
      id: 'row-1',
      eventType: 'member.registered',
      payload: {},
      attempts: 0,
      occurredAt: new Date(),
    };
    claimBatchMock.mockReset().mockResolvedValue([failingRow]);
    markPublishedMock.mockReset().mockResolvedValue(undefined);

    await runScheduledDrain({
      getDb: () => fakeDb(),
      EVENTS_QUEUE: { send: vi.fn().mockRejectedValue(new Error('queue down')) },
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
    });

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'athlya.outbox.drain_errors',
        metric: 'outbox_drain_errors',
        failed: 1,
      }),
    );
  });
});

describe('runScheduledDrain lease (issue #424)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const row = (n: number) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    eventId: `evt-${String(n)}`,
    eventType: 'member.registered',
    payload: {},
    attempts: 1,
    occurredAt: new Date(),
    studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });

  it('stamps every delivered row in one statement and emits the cycle metric', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rows = [row(1), row(2), row(3)];
    claimBatchMock.mockReset().mockResolvedValueOnce(rows).mockResolvedValue([]);
    markPublishedMock.mockReset().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await runScheduledDrain({
      getDb: () =>
        ({
          transaction: () => {
            throw new Error('no transaction expected');
          },
        }) as never,
      EVENTS_QUEUE: { send },
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
      batchSize: 3,
    });

    expect(result).toEqual({ processed: 3, succeeded: 3, failed: 0, released: 0 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(markPublishedMock).toHaveBeenCalledTimes(1);
    expect(markPublishedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(rows.map((r) => r.id)),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'outbox.drain_cycle',
        metric: 'outbox_drain_cycle',
        processed: 3,
        succeeded: 3,
      }),
    );
  });

  it('releases deadline-cut rows under their lease token without reporting drain errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leaseToken = '2026-10-17 12:00:00.123456+00';
    const rows = [row(1), row(2)].map((r) => ({ ...r, leaseToken }));
    claimBatchMock.mockReset().mockResolvedValue(rows);
    markPublishedMock.mockReset().mockResolvedValue(undefined);
    releaseLeasesMock.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    const send = vi.fn(async () => {
      vi.setSystemTime(Date.now() + DRAIN_CYCLE_DEADLINE_MS);
    });

    const result = await runScheduledDrain({
      getDb: () =>
        ({
          transaction: () => {
            throw new Error('no transaction expected');
          },
        }) as never,
      EVENTS_QUEUE: { send },
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
      batchSize: 2,
    });

    expect(result).toEqual({ processed: 2, succeeded: 1, failed: 0, released: 1 });
    expect(releaseLeasesMock).toHaveBeenCalledWith(expect.anything(), [rows[1]!.id], leaseToken);
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'athlya.outbox.drain_errors' }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'outbox.drain_cycle',
        failed: 0,
        released: 1,
      }),
    );
  });

  it('keeps the lease longer than the longest possible cycle', () => {
    expect(DRAIN_LEASE_SECONDS * 1000).toBeGreaterThan(
      DRAIN_CYCLE_DEADLINE_MS + DEFAULT_QUEUE_SEND_TIMEOUT_MS + 10_000,
    );
    expect(DRAIN_CYCLE_DEADLINE_MS).toBeLessThan(OUTBOX_DRAIN_OVERLAP_WARN_MS);
    expect(DRAIN_SEND_CONCURRENCY).toBeGreaterThan(1);
  });
});

describe('emitOutboxDrainErrorsMetric', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a no-op when there are no failures', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitOutboxDrainErrorsMetric({ processed: 5, succeeded: 5, failed: 0, released: 0 });
    expect(log).not.toHaveBeenCalled();
  });

  it('emits the drain_errors metric unconditionally when failed > 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitOutboxDrainErrorsMetric({ processed: 10, succeeded: 7, failed: 3, released: 0 });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'athlya.outbox.drain_errors',
        metric: 'outbox_drain_errors',
        failed: 3,
        processed: 10,
        succeeded: 7,
      }),
    );
  });

  it('forwards to logger.error when a logger is wired', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.fn();
    emitOutboxDrainErrorsMetric(
      { processed: 2, succeeded: 1, failed: 1, released: 0 },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: errorSpy,
      },
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'outbox drain: failed items in batch',
      expect.objectContaining({ metric: 'outbox_drain_errors', failed: 1 }),
    );
  });
});

describe('warnOnDrainOverlapRisk', () => {
  afterEach(() => vi.restoreAllMocks());

  const result: DrainResult = { processed: 200, succeeded: 200, failed: 0, released: 0 };

  it('stays silent when the drain is within the cron window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnOnDrainOverlapRisk(OUTBOX_DRAIN_OVERLAP_WARN_MS, result, ADAPTIVE_BATCH_SIZE)).toBe(
      false,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the duration metric when the drain risks overlap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fired = warnOnDrainOverlapRisk(
      OUTBOX_DRAIN_OVERLAP_WARN_MS + 1,
      result,
      ADAPTIVE_BATCH_SIZE,
    );
    expect(fired).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'outbox.drain_overlap_risk',
        metric: 'outbox_drain_duration_ms',
        durationMs: OUTBOX_DRAIN_OVERLAP_WARN_MS + 1,
        processed: 200,
      }),
    );
  });
});

describe('runScheduledDrain throughput and fairness (issue #311)', () => {
  afterEach(() => vi.restoreAllMocks());

  const env = (send: (m: unknown) => Promise<void>) => ({
    getDb: () => ({}) as never,
    EVENTS_QUEUE: { send },
    EVENTS_NOTIFICATIONS_QUEUE: { send },
    EVENTS_RGPD_QUEUE: { send },
    batchSize: 2,
  });
  const row = (n: number) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    eventId: `evt-${String(n)}`,
    eventType: 'reservation.created',
    payload: {},
    attempts: 1,
    occurredAt: new Date(),
    studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });

  it('keeps claiming batches within one cycle until the backlog is empty', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    claimBatchMock
      .mockReset()
      .mockResolvedValueOnce([row(1), row(2)])
      .mockResolvedValueOnce([row(3), row(4)])
      .mockResolvedValueOnce([row(5)])
      .mockResolvedValue([]);
    markPublishedMock.mockReset().mockResolvedValue(undefined);

    const result = await runScheduledDrain(env(async () => {}));

    expect(claimBatchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ processed: 5, succeeded: 5, failed: 0, released: 0 });
  });

  it('stops the cycle when a whole batch fails instead of spinning on a dead queue', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    claimBatchMock.mockReset().mockResolvedValue([row(1), row(2)]);

    const result = await runScheduledDrain(env(() => Promise.reject(new Error('queue down'))));

    expect(claimBatchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 2, succeeded: 0, failed: 2, released: 0 });
  });

  it('carries released rows across rounds and fences each release on its own claim', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = [row(1), row(2)].map((r) => ({ ...r, leaseToken: 'lease-round-1' }));
    const second = [row(3), row(4)].map((r) => ({ ...r, leaseToken: 'lease-round-2' }));
    claimBatchMock.mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    markPublishedMock.mockReset().mockResolvedValue(undefined);
    releaseLeasesMock.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    let sends = 0;
    const send = vi.fn(async () => {
      sends += 1;
      if (sends === 3) vi.setSystemTime(Date.now() + DRAIN_CYCLE_DEADLINE_MS);
    });

    try {
      const result = await runScheduledDrain(env(send));

      expect(claimBatchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ processed: 4, succeeded: 3, failed: 0, released: 1 });
      expect(releaseLeasesMock).toHaveBeenCalledTimes(1);
      expect(releaseLeasesMock).toHaveBeenCalledWith(
        expect.anything(),
        [second[1]!.id],
        'lease-round-2',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the rounds of one cycle', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    claimBatchMock.mockReset().mockImplementation(async () => [row(1), row(2)]);
    markPublishedMock.mockReset().mockResolvedValue(undefined);

    await runScheduledDrain(env(async () => {}));

    expect(claimBatchMock).toHaveBeenCalledTimes(DRAIN_MAX_ROUNDS);
  });

  it('claims compliance events first', () => {
    expect(COMPLIANCE_EVENT_TYPES).toEqual(
      expect.arrayContaining(['auth.user.deleted', 'members.export.requested']),
    );
  });
});

describe('outbox lane metrics (issue #311)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sums per-type rows into the global snapshot', () => {
    const old = new Date('2026-10-12T00:00:00Z');
    expect(
      totalSnapshot([
        { pending: 3, oldestOccurredAt: new Date('2026-10-12T01:00:00Z') },
        { pending: 4, oldestOccurredAt: old },
        { pending: 0, oldestOccurredAt: null },
      ]),
    ).toEqual({ pending: 7, oldestOccurredAt: old });
  });

  it('emits one backlog data point per lane with depth and oldest age', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tenMinAgo = new Date(Date.now() - 600_000);
    emitOutboxLaneMetrics([
      { eventType: 'reservation.created', pending: 10, oldestOccurredAt: new Date() },
      { eventType: 'reservation.cancelled', pending: 5, oldestOccurredAt: new Date() },
      { eventType: 'auth.user.deleted', pending: 1, oldestOccurredAt: tenMinAgo },
    ]);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'outbox.lane_backlog',
        lane: 'notifications',
        pending: 15,
      }),
    );
    const rgpd = log.mock.calls.find(
      (c) => (c[0] as { lane?: string } | undefined)?.lane === 'rgpd',
    )?.[0] as { pending: number; oldestAgeMs: number };
    expect(rgpd.pending).toBe(1);
    expect(rgpd.oldestAgeMs).toBeGreaterThanOrEqual(600_000);
  });

  it('reports a drained lane as zero instead of omitting it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitOutboxLaneMetrics([]);

    const lanes = log.mock.calls
      .map((c) => c[0] as { message: string; lane: string; pending: number; oldestAgeMs: number })
      .filter((event) => event.message === 'outbox.lane_backlog');
    expect(lanes).toEqual([
      expect.objectContaining({ lane: 'notifications', pending: 0, oldestAgeMs: 0 }),
      expect.objectContaining({ lane: 'rgpd', pending: 0, oldestAgeMs: 0 }),
      expect.objectContaining({ lane: 'legacy', pending: 0, oldestAgeMs: 0 }),
    ]);
  });
});

describe('configurable batch size (issue #311)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults the backlog batch to 500 events', () => {
    expect(ADAPTIVE_BATCH_SIZE).toBe(500);
    expect(resolveConfiguredBatchSize(undefined)).toBe(ADAPTIVE_BATCH_SIZE);
    expect(resolveConfiguredBatchSize(' ')).toBe(ADAPTIVE_BATCH_SIZE);
  });

  it('accepts a positive integer and clamps it to the claim limit', () => {
    expect(resolveConfiguredBatchSize('750')).toBe(750);
    expect(resolveConfiguredBatchSize('5000')).toBe(MAX_DRAIN_BATCH_SIZE);
    expect(MAX_DRAIN_BATCH_SIZE).toBe(1000);
  });

  it('ignores an invalid value with a configuration warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of ['0', '-5', '12.5', 'lots']) {
      expect(resolveConfiguredBatchSize(raw)).toBe(ADAPTIVE_BATCH_SIZE);
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('OUTBOX_DRAIN_BATCH_SIZE'),
      expect.objectContaining({ code: 'configuration_error' }),
    );
  });

  it('keeps the idle batch at the default and never above the configured size', () => {
    expect(pickBatchSize(0, 750)).toBe(DEFAULT_BATCH_SIZE);
    expect(pickBatchSize(OUTBOX_BACKLOG_BATCH_THRESHOLD + 1, 750)).toBe(750);
    expect(pickBatchSize(0, 40)).toBe(40);
  });

  it('sizes the cron claim from OUTBOX_DRAIN_BATCH_SIZE under backlog', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    countByTypeMock
      .mockReset()
      .mockResolvedValue([
        { eventType: 'reservation.created', pending: 900, oldestOccurredAt: null },
      ]);
    claimBatchMock.mockReset().mockResolvedValue([]);

    await runScheduledDrain({
      getDb: () => ({}) as never,
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
      OUTBOX_DRAIN_BATCH_SIZE: '800',
    });

    expect(claimBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      800,
      DRAIN_LEASE_SECONDS,
      COMPLIANCE_EVENT_TYPES,
    );
  });
});

describe('cycle capacity (issue #311 acceptance: 500+ per batch, 10k burst)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** In-memory outbox: `claimLeasedBatch` hands out FIFO slices of `total` rows. */
  function backlog(total: number) {
    let next = 0;
    claimBatchMock.mockReset().mockImplementation(async (_db: unknown, size: number) => {
      const rows = [];
      for (let i = 0; i < size && next < total; i += 1, next += 1) {
        rows.push({
          id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
          eventId: `evt-${String(next)}`,
          eventType: 'reservation.reminder',
          payload: {},
          attempts: 1,
          occurredAt: new Date(),
          studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          leaseToken: `lease-${String(next)}`,
        });
      }
      return rows;
    });
    markPublishedMock.mockReset().mockResolvedValue(undefined);
    countByTypeMock
      .mockReset()
      .mockResolvedValue([
        { eventType: 'reservation.reminder', pending: total, oldestOccurredAt: null },
      ]);
  }

  it('the default configuration bounds one cycle above the 10k burst target', () => {
    expect(drainCycleCapacity(ADAPTIVE_BATCH_SIZE)).toBeGreaterThanOrEqual(10_000);
    expect(drainCycleCapacity(ADAPTIVE_BATCH_SIZE, KICK_DRAIN_MAX_ROUNDS)).toBeGreaterThanOrEqual(
      ADAPTIVE_BATCH_SIZE,
    );
  });

  it('delivers a 10 000-event burst in ONE cron cycle with 500-event batches', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    backlog(10_000);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await runScheduledDrain({
      getDb: () => ({}) as never,
      EVENTS_QUEUE: { send },
      EVENTS_NOTIFICATIONS_QUEUE: { send },
      EVENTS_RGPD_QUEUE: { send },
    });

    expect(result).toEqual({ processed: 10_000, succeeded: 10_000, failed: 0, released: 0 });
    expect(send).toHaveBeenCalledTimes(10_000);
    // 20 full batches of 500, plus the empty claim that proves the backlog is gone.
    expect(claimBatchMock).toHaveBeenCalledTimes(21);
    for (const call of claimBatchMock.mock.calls) {
      expect(call[1]).toBe(ADAPTIVE_BATCH_SIZE);
    }
  });

  it('stops at batch × rounds when the backlog exceeds one cycle', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    backlog(30_000);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await runScheduledDrain({
      getDb: () => ({}) as never,
      EVENTS_QUEUE: { send },
      EVENTS_NOTIFICATIONS_QUEUE: { send },
      EVENTS_RGPD_QUEUE: { send },
    });

    expect(result.succeeded).toBe(drainCycleCapacity(ADAPTIVE_BATCH_SIZE, DRAIN_MAX_ROUNDS));
  });
});

describe('runKickDrain (issue #311)', () => {
  afterEach(() => vi.restoreAllMocks());

  const row = (n: number) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    eventId: `evt-${String(n)}`,
    eventType: 'auth.user.deleted',
    payload: {},
    attempts: 1,
    occurredAt: new Date(),
    studioId: null,
    leaseToken: 'lease',
  });

  it('claims compliance-first at the backlog size without the pending snapshot', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    countByTypeMock.mockReset();
    claimBatchMock
      .mockReset()
      .mockResolvedValueOnce([row(1)])
      .mockResolvedValue([]);
    markPublishedMock.mockReset().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await runKickDrain({
      getDb: () => ({}) as never,
      EVENTS_QUEUE: { send },
      EVENTS_NOTIFICATIONS_QUEUE: { send },
      EVENTS_RGPD_QUEUE: { send },
    });

    expect(result.succeeded).toBe(1);
    expect(countByTypeMock).not.toHaveBeenCalled();
    expect(claimBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      ADAPTIVE_BATCH_SIZE,
      DRAIN_LEASE_SECONDS,
      COMPLIANCE_EVENT_TYPES,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'outbox.drain_cycle',
        trigger: 'kick',
        succeeded: 1,
        deadlineMs: KICK_DRAIN_DEADLINE_MS,
      }),
    );
    expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'outbox.backlog' }));
  });

  it('is bounded to fewer rounds than the cron cycle', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    claimBatchMock
      .mockReset()
      .mockImplementation(async (_db: unknown, size: number) =>
        Array.from({ length: size }, (_, i) => row(i)),
      );
    markPublishedMock.mockReset().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);

    await runKickDrain({
      getDb: () => ({}) as never,
      EVENTS_QUEUE: { send },
      EVENTS_NOTIFICATIONS_QUEUE: { send },
      EVENTS_RGPD_QUEUE: { send },
      OUTBOX_DRAIN_BATCH_SIZE: '2',
    });

    expect(claimBatchMock).toHaveBeenCalledTimes(KICK_DRAIN_MAX_ROUNDS);
    expect(KICK_DRAIN_MAX_ROUNDS).toBeLessThan(DRAIN_MAX_ROUNDS);
    expect(KICK_DRAIN_DEADLINE_MS).toBeLessThan(DRAIN_CYCLE_DEADLINE_MS);
    // A kick drain must never outlive the lease it claims under.
    expect(DRAIN_LEASE_SECONDS * 1000).toBeGreaterThan(
      KICK_DRAIN_DEADLINE_MS + DEFAULT_QUEUE_SEND_TIMEOUT_MS + 10_000,
    );
  });
});
