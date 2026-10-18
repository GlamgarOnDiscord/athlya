/**
 * Gateway `queue()` dispatch of the outbox kick queue (issue #311).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const runKickDrainMock = vi.hoisted(() => vi.fn());
const withDrainDbMock = vi.hoisted(() => vi.fn());

vi.mock('../events/drain-scheduled.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/drain-scheduled.js')>();
  return { ...actual, runKickDrain: runKickDrainMock };
});

vi.mock('../adapters/drain-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/drain-db.js')>();
  return { ...actual, withDrainDb: withDrainDbMock };
});

import workerDefault from '../worker.js';

import type { MessageBatch } from '@cloudflare/workers-types';

function kickBatch(size: number) {
  return {
    queue: 'athlya-outbox-kick-staging',
    messages: Array.from({ length: size }, () => ({
      body: { type: 'outbox.kick', sentAt: '', compliance: false },
    })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

const ctx = { waitUntil: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  runKickDrainMock.mockReset();
  withDrainDbMock.mockReset();
});

describe('worker.queue — outbox kick lane', () => {
  it('runs one kick drain as athlya_cron for the whole batch and returns its promise', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = {};
    withDrainDbMock.mockImplementation(async (_url: string, fn: (d: unknown) => Promise<unknown>) =>
      fn(db),
    );
    runKickDrainMock.mockResolvedValue({ processed: 3, succeeded: 3, failed: 0, released: 0 });
    const batch = kickBatch(40);

    const pending = workerDefault.queue(
      batch as unknown as MessageBatch<unknown>,
      { ENVIRONMENT: 'staging', CRON_DB_URL: 'postgres://cron@db/athlya' } as never,
      ctx,
    );
    expect(pending).toBeInstanceOf(Promise);
    await pending;

    expect(withDrainDbMock).toHaveBeenCalledTimes(1);
    expect(withDrainDbMock.mock.calls[0]![0]).toBe('postgres://cron@db/athlya');
    expect(runKickDrainMock).toHaveBeenCalledTimes(1);
    const env = runKickDrainMock.mock.calls[0]![0] as { getDb: () => unknown };
    expect(env.getDb()).toBe(db);
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('acks without draining when CRON_DB_URL is missing outside dev', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const batch = kickBatch(1);

    await workerDefault.queue(
      batch as unknown as MessageBatch<unknown>,
      { ENVIRONMENT: 'production' } as never,
      ctx,
    );

    expect(withDrainDbMock).not.toHaveBeenCalled();
    expect(batch.ackAll).toHaveBeenCalledTimes(1);
  });
});
