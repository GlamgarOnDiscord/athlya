/**
 * Contract between the log-based Axiom SLO monitors and the runtime
 * (issue #693).
 *
 * `infra/terraform/axiom-monitors.tf` filters log events on
 * `['message'] == "<label>"` and reads metric fields at the top level of
 * the event. The log pipeline delivers each console call's single
 * structured argument as one Axiom event (field contract in
 * docs/runbooks/axiom-alerts-provision.md), so this suite captures the
 * console calls of the real emitters and checks that every field a
 * monitor references exists, at that path, with a numeric value.
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetDlqRedisCache,
  __setDlqRedisForTests,
  handleDlqBatch,
} from '../events/drain-dlq.js';
import { emitOutboxBacklogMetric } from '../events/drain-scheduled.js';
import { DEFAULT_BATCH_SIZE } from '../events/drain-worker.js';

import type { MessageBatch } from '@cloudflare/workers-types';
import type { Redis } from '@upstash/redis';

interface LogMonitor {
  readonly key: string;
  readonly message: string;
  readonly fields: readonly string[];
  readonly query: string;
}

const terraform = readFileSync(
  new URL('../../../../infra/terraform/axiom-monitors.tf', import.meta.url),
  'utf8',
);

/** Every `<key> = { … apl_query = <<-APL … APL` monitor reading the logs dataset. */
function logMonitors(source: string): LogMonitor[] {
  const monitors: LogMonitor[] = [];
  for (const [, key, query] of source.matchAll(
    /\n {4}([a-z0-9_]+) = \{[^]*?apl_query\s*=\s*<<-APL\n([^]*?)\n\s*APL\n/g,
  )) {
    if (key === undefined || query === undefined || !query.includes('local.axiom_logs')) continue;
    const message = /\['message'\] == "([^"]+)"/.exec(query)?.[1];
    if (message === undefined) throw new Error(`${key}: no ['message'] filter`);
    const fields = [...query.matchAll(/\['([^'\]]+)'\]/g)]
      .map(([, field]) => field)
      .filter((field): field is string => field !== undefined && field !== 'message');
    monitors.push({ key, message, fields: [...new Set(fields)], query });
  }
  return monitors;
}

/** Console calls captured while the real emitters run. */
async function captureRuntimeEvents(): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  for (const method of ['debug', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
  }

  emitOutboxBacklogMetric(
    { pending: 12, oldestOccurredAt: new Date(Date.now() - 90_000) },
    DEFAULT_BATCH_SIZE,
  );

  const redisUrl = 'https://axiom-contract.upstash.io';
  __setDlqRedisForTests(redisUrl, { zcard: async () => 3 } as unknown as Redis);
  await handleDlqBatch({ messages: [], queue: 'athlya-events-dlq' } as unknown as MessageBatch, {
    EVENTS_QUEUE: {} as never,
    EVENTS_NOTIFICATIONS_QUEUE: {} as never,
    EVENTS_RGPD_QUEUE: {} as never,
    EVENTS_DLQ: {} as never,
    REDIS_URL: redisUrl,
    REDIS_TOKEN: 'test-token',
  });

  return calls;
}

describe('Axiom log monitors ↔ runtime log events (issue #693)', () => {
  const monitors = logMonitors(terraform);
  let calls: unknown[][] = [];

  beforeEach(async () => {
    __resetDlqRedisCache();
    calls = await captureRuntimeEvents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetDlqRedisCache();
  });

  it('finds the three log-based monitors in axiom-monitors.tf', () => {
    expect(monitors.map(({ key }) => key).sort()).toEqual([
      'dlq_depth',
      'outbox_backlog',
      'queue_lag',
    ]);
  });

  it('reads log fields only through bracketed top-level paths', () => {
    for (const { key, query } of monitors) {
      for (const [, argument] of query.matchAll(/\bto(?:int|long|double|string)\(([^)]*)\)/g)) {
        expect(argument, key).toMatch(/^\['[A-Za-z0-9_]+'\]$/);
      }
      expect(query, key).not.toMatch(/\['(?:fields|attributes|data|Logs|Message)'\]/);
    }
  });

  for (const monitor of logMonitors(terraform)) {
    it(`${monitor.key}: "${monitor.message}" is one flat event carrying ${monitor.fields.join(', ')}`, () => {
      const matching = calls.filter((args) =>
        args.some(
          (arg) =>
            arg === monitor.message ||
            (typeof arg === 'object' &&
              arg !== null &&
              (arg as { message?: unknown }).message === monitor.message),
        ),
      );
      expect(matching, `no console call emits "${monitor.message}"`).not.toHaveLength(0);

      for (const args of matching) {
        expect(args, 'one structured argument per line').toHaveLength(1);
        const event = args[0] as Record<string, unknown>;
        expect(Object.getPrototypeOf(event)).toBe(Object.prototype);
        expect(event['message']).toBe(monitor.message);
        for (const field of monitor.fields) {
          expect(event, `${monitor.key} reads ['${field}']`).toHaveProperty([field]);
          expect(typeof event[field], `${monitor.key}: ['${field}'] must be numeric`).toBe(
            'number',
          );
        }
        expect(JSON.parse(JSON.stringify(event))).toEqual(event);
      }
    });
  }
});
