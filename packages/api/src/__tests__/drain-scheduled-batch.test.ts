import { describe, expect, it, vi } from 'vitest';

import {
  ADAPTIVE_BATCH_SIZE,
  OUTBOX_BACKLOG_BATCH_THRESHOLD,
  resolveDrainBatchSize,
} from '../events/drain-scheduled.js';
import { DEFAULT_BATCH_SIZE } from '../events/drain-worker.js';

const countPendingOutboxMock = vi.hoisted(() => vi.fn());

vi.mock('@athlya/db/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@athlya/db/outbox')>();
  return {
    ...actual,
    countPendingOutbox: countPendingOutboxMock,
  };
});

describe('resolveDrainBatchSize', () => {
  it('honours env.batchSize override', async () => {
    const size = await resolveDrainBatchSize({} as never, { getDb: vi.fn(), EVENTS_QUEUE: {} as never, batchSize: 42 });
    expect(size).toBe(42);
    expect(countPendingOutboxMock).not.toHaveBeenCalled();
  });

  it('uses adaptive batch size when pending exceeds threshold', async () => {
    countPendingOutboxMock.mockResolvedValue({
      pending: OUTBOX_BACKLOG_BATCH_THRESHOLD + 1,
      oldestOccurredAt: null,
    });
    const size = await resolveDrainBatchSize({} as never, { getDb: vi.fn(), EVENTS_QUEUE: {} as never });
    expect(size).toBe(ADAPTIVE_BATCH_SIZE);
  });

  it('uses default batch size under threshold', async () => {
    countPendingOutboxMock.mockResolvedValue({ pending: 10, oldestOccurredAt: null });
    const size = await resolveDrainBatchSize({} as never, { getDb: vi.fn(), EVENTS_QUEUE: {} as never });
    expect(size).toBe(DEFAULT_BATCH_SIZE);
  });
});
