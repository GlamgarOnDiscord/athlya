/**
 * Contract between the log-based Axiom SLO monitors and the log events
 * the runtime emits (issues #693, #697), shared by the runtime suite
 * (`axiom-log-monitors.contract.test.ts`) and the log pipeline suite
 * (`axiom-tail.test.ts`).
 *
 * `infra/terraform/axiom-monitors.tf` filters log events on
 * `['message'] == "<label>"` and reads metric fields at the top level of
 * the event (field contract in docs/runbooks/axiom-alerts-provision.md).
 */

import { readFileSync } from 'node:fs';

import { expect, vi } from 'vitest';

import { handleDlqBatch, __setDlqRedisForTests } from '../../events/drain-dlq.js';
import { emitOutboxBacklogMetric } from '../../events/drain-scheduled.js';
import { DEFAULT_BATCH_SIZE } from '../../events/drain-worker.js';

import type { MessageBatch } from '@cloudflare/workers-types';
import type { Redis } from '@upstash/redis';

export interface LogMonitor {
  readonly key: string;
  readonly message: string;
  readonly fields: readonly string[];
  readonly query: string;
}

export const AXIOM_MONITORS_TF = readFileSync(
  new URL('../../../../../infra/terraform/axiom-monitors.tf', import.meta.url),
  'utf8',
);

/** Every `<key> = { … apl_query = <<-APL … APL` monitor reading the logs dataset. */
export function logMonitors(source: string = AXIOM_MONITORS_TF): LogMonitor[] {
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

/**
 * Console calls captured while the real emitters run. Spies on the
 * console methods; the caller restores them (`vi.restoreAllMocks()`).
 */
export async function captureRuntimeEvents(): Promise<unknown[][]> {
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

/** Asserts `event` is what `monitor` reads: its label and numeric top-level fields. */
export function expectMonitoredEvent(monitor: LogMonitor, event: Record<string, unknown>): void {
  expect(event['message']).toBe(monitor.message);
  for (const field of monitor.fields) {
    expect(event, `${monitor.key} reads ['${field}']`).toHaveProperty([field]);
    expect(typeof event[field], `${monitor.key}: ['${field}'] must be numeric`).toBe('number');
  }
  expect(JSON.parse(JSON.stringify(event))).toEqual(event);
}
