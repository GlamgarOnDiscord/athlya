/**
 * Axiom Tail Worker (issue #697): the events it ships satisfy the same
 * monitor contract as the runtime lines (`helpers/axiom-log-contract.ts`),
 * everything else in the trace is dropped, and shipping never throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetDlqRedisCache } from '../events/drain-dlq.js';
import {
  INGEST_BATCH_SIZE,
  INGEST_TIMEOUT_MS,
  shipToAxiom,
  toAxiomEvents,
} from '../workers/axiom-tail.js';

import {
  captureRuntimeEvents,
  expectMonitoredEvent,
  logMonitors,
} from './helpers/axiom-log-contract.js';

const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const ENV = { AXIOM_INGEST_TOKEN: 'xaat-test', AXIOM_LOGS_DATASET: 'athlya-logs' };

function trace(
  messages: readonly unknown[],
  event: TraceItem['event'] = { cron: '* * * * *', scheduledTime: T0 },
): TraceItem {
  return {
    event,
    eventTimestamp: T0,
    logs: messages.map((message, index) => ({
      timestamp: T0 + index,
      level: 'log',
      message,
    })),
    exceptions: [{ timestamp: T0, name: 'Error', message: 'boom', stack: 'at x' }],
    diagnosticsChannelEvents: [],
    scriptName: 'athlya-api-production',
    outcome: 'ok',
    executionModel: 'stateless',
    truncated: false,
    cpuTime: 3,
    wallTime: 9,
  };
}

const ingested = (fetcher: ReturnType<typeof vi.fn>): unknown[] =>
  fetcher.mock.calls.flatMap(
    (call) => JSON.parse((call[1] as RequestInit).body as string) as unknown[],
  );

describe('toAxiomEvents ↔ Axiom log monitors', () => {
  let calls: unknown[][] = [];

  beforeEach(async () => {
    __resetDlqRedisCache();
    calls = await captureRuntimeEvents();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    __resetDlqRedisCache();
  });

  for (const monitor of logMonitors()) {
    it(`ships "${monitor.message}" as one flat event ${monitor.key} can read`, () => {
      const events = toAxiomEvents([trace(calls)]).filter(
        (event) => event['message'] === monitor.message,
      );
      expect(events, `no shipped event for "${monitor.message}"`).not.toHaveLength(0);
      for (const event of events) expectMonitoredEvent(monitor, event);
    });
  }
});

describe('toAxiomEvents', () => {
  it('keeps the log object at the top level with the trace metadata only', () => {
    const [event] = toAxiomEvents([trace([[{ message: 'outbox.backlog', pending: 4 }]])]);
    expect(event).toEqual({
      _time: '2026-10-19T12:00:00.000Z',
      level: 'log',
      scriptName: 'athlya-api-production',
      outcome: 'ok',
      eventTimestamp: T0,
      eventType: 'scheduled',
      cron: '* * * * *',
      message: 'outbox.backlog',
      pending: 4,
    });
  });

  it('records the queue of a queue invocation and nothing of a fetch request', () => {
    const line = [{ message: 'm' }];
    const [queued] = toAxiomEvents([trace([line], { queue: 'athlya-events-dlq', batchSize: 3 })]);
    expect(queued).toMatchObject({ eventType: 'queue', queue: 'athlya-events-dlq' });

    const request = {
      request: {
        url: 'https://api.athlya.app/v1/auth/login?email=a@b.c',
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      },
    } as unknown as TraceItem['event'];
    const [fetched] = toAxiomEvents([trace([line], request)]);
    expect(fetched).toMatchObject({ eventType: 'fetch' });
    expect(JSON.stringify(fetched)).not.toMatch(/athlya\.app|Bearer|email/u);
  });

  it('lets a key of the log object win over the trace metadata', () => {
    const [event] = toAxiomEvents([
      trace([[{ message: 'device attestation verdict', outcome: 'pass' }]]),
    ]);
    expect(event?.['outcome']).toBe('pass');
  });

  it('drops strings, argument lists, arrays, class instances and empty messages', () => {
    const events = toAxiomEvents([
      trace([
        ['{"msg":"served"}'],
        ['label', { pending: 1 }],
        [[{ message: 'nested' }]],
        [new Date(T0)],
        [],
        'not an array',
        [null],
      ]),
    ]);
    expect(events).toEqual([]);
  });

  it('never ships exceptions or other trace fields', () => {
    const [event] = toAxiomEvents([trace([[{ message: 'm' }]])]);
    expect(Object.keys(event ?? {}).sort()).toEqual(
      [
        '_time',
        'cron',
        'eventTimestamp',
        'eventType',
        'level',
        'message',
        'outcome',
        'scriptName',
      ].sort(),
    );
  });
});

describe('shipToAxiom', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('posts the events to the dataset ingest endpoint with the token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await shipToAxiom([trace([[{ message: 'outbox.backlog', pending: 1 }]])], ENV, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.axiom.co/v1/datasets/athlya-logs/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: 'Bearer xaat-test',
      'content-type': 'application/json',
    });
    expect(ingested(fetcher)).toEqual([expect.objectContaining({ message: 'outbox.backlog' })]);
  });

  it('uses the configured Axiom origin', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await shipToAxiom(
      [trace([[{ message: 'm' }]])],
      { ...ENV, AXIOM_URL: 'https://eu.axiom.test/' },
      fetcher,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://eu.axiom.test/v1/datasets/athlya-logs/ingest');
  });

  it('splits large tails into batches', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const lines = Array.from({ length: INGEST_BATCH_SIZE + 1 }, (_, i) => [{ message: 'm', i }]);
    await shipToAxiom([trace(lines)], ENV, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ingested(fetcher)).toHaveLength(INGEST_BATCH_SIZE + 1);
  });

  it('sends nothing when there is no flat event or no configuration', async () => {
    const fetcher = vi.fn();
    await shipToAxiom([trace([['plain string']])], ENV, fetcher);
    await shipToAxiom([trace([[{ message: 'm' }]])], {}, fetcher);
    await shipToAxiom([trace([[{ message: 'm' }]])], { ...ENV, AXIOM_INGEST_TOKEN: '' }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('resolves on an HTTP error or a network failure', async () => {
    const refused = vi.fn().mockResolvedValue(new Response('quota', { status: 429 }));
    await expect(shipToAxiom([trace([[{ message: 'm' }]])], ENV, refused)).resolves.toBeUndefined();
    const broken = vi.fn().mockRejectedValue(new TypeError('network'));
    await expect(shipToAxiom([trace([[{ message: 'm' }]])], ENV, broken)).resolves.toBeUndefined();
  });

  it('aborts a request that exceeds the timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const shipped = shipToAxiom(
      [trace([[{ message: 'm' }]])],
      ENV,
      fetcher as unknown as typeof fetch,
    );
    await vi.advanceTimersByTimeAsync(INGEST_TIMEOUT_MS);
    await expect(shipped).resolves.toBeUndefined();
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('resolves on a malformed tail item', async () => {
    const fetcher = vi.fn();
    await expect(
      shipToAxiom([{ logs: null } as unknown as TraceItem], ENV, fetcher),
    ).resolves.toBeUndefined();
  });
});
