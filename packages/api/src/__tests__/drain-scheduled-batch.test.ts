import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ADAPTIVE_BATCH_SIZE,
  OUTBOX_BACKLOG_BATCH_THRESHOLD,
  OUTBOX_DRAIN_OVERLAP_WARN_MS,
  emitOutboxBacklogMetric,
  pickBatchSize,
  resolveDrainBatchSize,
  runScheduledDrain,
  warnOnDrainOverlapRisk,
} from '../events/drain-scheduled.js';
import { DEFAULT_BATCH_SIZE, type DrainResult } from '../events/drain-worker.js';

const countPendingOutboxMock = vi.hoisted(() => vi.fn());
const claimBatchMock = vi.hoisted(() => vi.fn());
const markPublishedMock = vi.hoisted(() => vi.fn());

vi.mock('@athlya/db/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@athlya/db/outbox')>();
  return {
    ...actual,
    countPendingOutbox: countPendingOutboxMock,
    claimBatch: claimBatchMock,
    markPublished: markPublishedMock,
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
      'outbox.backlog',
      expect.objectContaining({
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

  function fakeDb() {
    const tx = {};
    return { transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)) } as never;
  }

  it('queries pending once per cycle and emits the backlog metric', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    countPendingOutboxMock.mockReset().mockResolvedValue({
      pending: OUTBOX_BACKLOG_BATCH_THRESHOLD + 50,
      oldestOccurredAt: null,
    });
    claimBatchMock.mockReset().mockResolvedValue([]);

    const result = await runScheduledDrain({
      getDb: () => fakeDb(),
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
    });

    expect(countPendingOutboxMock).toHaveBeenCalledTimes(1);
    expect(claimBatchMock).toHaveBeenCalledWith(expect.anything(), ADAPTIVE_BATCH_SIZE);
    expect(log).toHaveBeenCalledWith(
      'outbox.backlog',
      expect.objectContaining({ metric: 'outbox_pending_count', backlog: true }),
    );
    expect(result.processed).toBe(0);
  });

  it('skips the snapshot query when batchSize is overridden', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    countPendingOutboxMock.mockReset();
    claimBatchMock.mockReset().mockResolvedValue([]);

    await runScheduledDrain({
      getDb: () => fakeDb(),
      EVENTS_QUEUE: {} as never,
      EVENTS_NOTIFICATIONS_QUEUE: {} as never,
      EVENTS_RGPD_QUEUE: {} as never,
      batchSize: 25,
    });

    expect(countPendingOutboxMock).not.toHaveBeenCalled();
    expect(claimBatchMock).toHaveBeenCalledWith(expect.anything(), 25);
  });
});

describe('warnOnDrainOverlapRisk', () => {
  afterEach(() => vi.restoreAllMocks());

  const result: DrainResult = { processed: 200, succeeded: 200, failed: 0 };

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
      'outbox.drain_overlap_risk',
      expect.objectContaining({
        metric: 'outbox_drain_duration_ms',
        durationMs: OUTBOX_DRAIN_OVERLAP_WARN_MS + 1,
        processed: 200,
      }),
    );
  });
});
