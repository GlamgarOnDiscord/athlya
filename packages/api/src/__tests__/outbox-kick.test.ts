import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDomainScope } from '../domain-scope.js';
import {
  OUTBOX_KICK_MESSAGE_TYPE,
  OUTBOX_KICK_MIN_INTERVAL_MS,
  OUTBOX_KICK_RETRY_DELAY_SECONDS,
  OutboxKickCoalescer,
  handleOutboxKickBatch,
  isOutboxKickQueue,
  noteOutboxWrite,
  runWithOutboxKickScope,
  type KickRequestContext,
  type OutboxKickBatch,
  type OutboxKickProducer,
} from '../events/outbox-kick.js';

import type { HonoEnv } from '../types.js';

/** Clock + sleep doubles: `sleep` resolves only when the test releases it. */
function fakeTime() {
  let now = 1_000_000;
  const sleeps: Array<{ ms: number; release: () => void }> = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push({ ms, release: resolve });
      }),
  };
}

function producer() {
  const send = vi.fn<(message: unknown) => Promise<unknown>>().mockResolvedValue(undefined);
  return { send } satisfies OutboxKickProducer;
}

function requestContext(
  queue: OutboxKickProducer | undefined,
  waitUntil?: (p: Promise<unknown>) => void,
): KickRequestContext {
  return {
    env: { OUTBOX_KICK_QUEUE: queue },
    get executionCtx() {
      if (waitUntil === undefined) throw new Error('This context has no ExecutionContext');
      return { waitUntil };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('noteOutboxWrite', () => {
  it('is a no-op outside a request scope', () => {
    expect(() => {
      noteOutboxWrite('auth.user.deleted');
    }).not.toThrow();
  });
});

describe('runWithOutboxKickScope (producer)', () => {
  it('sends nothing when the request wrote no outbox row', async () => {
    const queue = producer();
    await runWithOutboxKickScope(requestContext(queue), async () => {});
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('kicks once, after the handler returned, however many rows it wrote', async () => {
    const queue = producer();
    const order: string[] = [];
    queue.send.mockImplementation(() => {
      order.push('kick');
      return Promise.resolve();
    });

    await runWithOutboxKickScope(
      requestContext(queue),
      async () => {
        noteOutboxWrite('reservation.created');
        await Promise.resolve();
        noteOutboxWrite('reservation.cancelled');
        order.push('commit');
      },
      new OutboxKickCoalescer(),
    );

    expect(order).toEqual(['commit', 'kick']);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: OUTBOX_KICK_MESSAGE_TYPE, compliance: false }),
    );
  });

  it('flags a kick triggered by a compliance event', async () => {
    const queue = producer();
    await runWithOutboxKickScope(
      requestContext(queue),
      async () => {
        noteOutboxWrite('reservation.created');
        noteOutboxWrite('auth.user.deleted');
      },
      new OutboxKickCoalescer(),
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ compliance: true }));
  });

  it('hands the kick to waitUntil instead of delaying the response', async () => {
    const queue = producer();
    const waitUntil = vi.fn();
    await runWithOutboxKickScope(
      requestContext(queue, waitUntil),
      async () => {
        noteOutboxWrite('members.export.requested');
      },
      new OutboxKickCoalescer(),
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it('still kicks when the handler throws after writing', async () => {
    const queue = producer();
    await expect(
      runWithOutboxKickScope(
        requestContext(queue),
        async () => {
          noteOutboxWrite('reservation.created');
          throw new Error('boom');
        },
        new OutboxKickCoalescer(),
      ),
    ).rejects.toThrow('boom');
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without the OUTBOX_KICK_QUEUE binding', async () => {
    await expect(
      runWithOutboxKickScope(requestContext(undefined), async () => {
        noteOutboxWrite('auth.user.deleted');
      }),
    ).resolves.toBeUndefined();
  });

  it('isolates concurrent requests: only the one that wrote kicks', async () => {
    const queue = producer();
    const coalescer = new OutboxKickCoalescer({ minIntervalMs: 0 });
    await Promise.all([
      runWithOutboxKickScope(requestContext(queue), async () => {}, coalescer),
      runWithOutboxKickScope(
        requestContext(queue),
        async () => {
          await Promise.resolve();
          noteOutboxWrite('reservation.created');
        },
        coalescer,
      ),
      runWithOutboxKickScope(requestContext(queue), async () => {}, coalescer),
    ]);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it('never fails the request when the kick cannot be sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queue = producer();
    queue.send.mockRejectedValue(new Error('queue down'));
    await runWithOutboxKickScope(
      requestContext(queue),
      async () => {
        noteOutboxWrite('auth.user.deleted');
      },
      new OutboxKickCoalescer(),
    );
    expect(warn).toHaveBeenCalledWith(
      'outbox.kick_failed',
      expect.objectContaining({ metric: 'outbox_kick_failed', compliance: true }),
    );
  });
});

describe('OutboxKickCoalescer', () => {
  it('sends at once, then arms ONE trailing kick for the rest of the window', async () => {
    const time = fakeTime();
    const coalescer = new OutboxKickCoalescer(time);
    const queue = producer();

    await coalescer.kick(queue, false);
    expect(queue.send).toHaveBeenCalledTimes(1);

    time.advance(200);
    const trailing = coalescer.kick(queue, false);
    const covered = coalescer.kick(queue, true);
    await covered;
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toHaveLength(1);
    expect(time.sleeps[0]!.ms).toBe(OUTBOX_KICK_MIN_INTERVAL_MS - 200);

    time.advance(OUTBOX_KICK_MIN_INTERVAL_MS - 200);
    time.sleeps[0]!.release();
    await trailing;
    expect(queue.send).toHaveBeenCalledTimes(2);
    // The compliance flag of a request covered by the trailing kick is kept.
    expect(queue.send).toHaveBeenLastCalledWith(expect.objectContaining({ compliance: true }));
  });

  it('sends immediately again once the window has passed', async () => {
    const time = fakeTime();
    const coalescer = new OutboxKickCoalescer(time);
    const queue = producer();

    await coalescer.kick(queue, false);
    time.advance(OUTBOX_KICK_MIN_INTERVAL_MS);
    await coalescer.kick(queue, false);

    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(time.sleeps).toHaveLength(0);
  });

  it('collapses a burst of 1 000 writes in one isolate into two kicks', async () => {
    const time = fakeTime();
    const coalescer = new OutboxKickCoalescer(time);
    const queue = producer();

    const kicks = Array.from({ length: 1000 }, () => coalescer.kick(queue, false));
    time.sleeps.forEach((s) => {
      s.release();
    });
    await Promise.all(kicks);

    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it('every write is followed by a kick sent after it', async () => {
    const time = fakeTime();
    const coalescer = new OutboxKickCoalescer(time);
    const queue = producer();
    const sentAt: number[] = [];
    queue.send.mockImplementation(() => {
      sentAt.push(time.now());
      return Promise.resolve();
    });

    const writes: number[] = [];
    const pending: Array<Promise<void>> = [];
    for (let i = 0; i < 5; i += 1) {
      writes.push(time.now());
      pending.push(coalescer.kick(queue, false));
      time.advance(150);
    }
    time.sleeps.forEach((s) => {
      s.release();
    });
    await Promise.all(pending);

    for (const w of writes) {
      expect(sentAt.some((s) => s >= w)).toBe(true);
    }
  });
});

describe('installDomainScope wires the kick on /v1/*', () => {
  it('kicks after a domain handler that wrote an outbox row', async () => {
    const queue = producer();
    const app = new Hono<HonoEnv>();
    installDomainScope(app, 'test', () => ({}));
    app.post('/v1/things', (c) => {
      noteOutboxWrite('auth.user.deleted');
      return c.json({ ok: true }, 201);
    });
    app.get('/v1/things', (c) => c.json({ ok: true }));

    const env = { ENVIRONMENT: 'dev', OUTBOX_KICK_QUEUE: queue } as unknown as HonoEnv['Bindings'];
    const read = await app.request('/v1/things', { method: 'GET' }, env);
    expect(read.status).toBe(200);
    expect(queue.send).not.toHaveBeenCalled();

    const write = await app.request('/v1/things', { method: 'POST' }, env);
    expect(write.status).toBe(201);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ compliance: true }));
  });
});

describe('handleOutboxKickBatch (consumer)', () => {
  function batch(size: number) {
    return {
      queue: 'athlya-outbox-kick',
      messages: Array.from({ length: size }, (_, i) => ({
        body: { type: OUTBOX_KICK_MESSAGE_TYPE, sentAt: '', compliance: i === 0 },
      })),
      ackAll: vi.fn<() => void>(),
      retryAll: vi.fn<(options?: { delaySeconds?: number }) => void>(),
    } satisfies OutboxKickBatch;
  }

  it('runs ONE drain for a whole batch of kicks and acks it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = batch(100);
    const drain = vi
      .fn()
      .mockResolvedValue({ processed: 12, succeeded: 12, failed: 0, released: 0 });

    await handleOutboxKickBatch(b, drain);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(b.ackAll).toHaveBeenCalledTimes(1);
    expect(b.retryAll).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'outbox.kick_drain',
      expect.objectContaining({ kicks: 100, compliance: true, succeeded: 12, skipped: false }),
    );
  });

  it('acks when the drain is skipped (no drain connection)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = batch(1);
    await handleOutboxKickBatch(b, async () => null);
    expect(b.ackAll).toHaveBeenCalledTimes(1);
  });

  it('retries the batch after a delay when the drain throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = batch(3);
    await handleOutboxKickBatch(b, () => Promise.reject(new Error('db down')));
    expect(b.ackAll).not.toHaveBeenCalled();
    expect(b.retryAll).toHaveBeenCalledWith({ delaySeconds: OUTBOX_KICK_RETRY_DELAY_SECONDS });
  });

  it('recognises the kick queue of every environment', () => {
    expect(isOutboxKickQueue('athlya-outbox-kick')).toBe(true);
    expect(isOutboxKickQueue('athlya-outbox-kick-staging')).toBe(true);
    expect(isOutboxKickQueue('athlya-outbox-kick-preview-pr-12')).toBe(true);
    expect(isOutboxKickQueue('athlya-events-rgpd')).toBe(false);
  });
});
