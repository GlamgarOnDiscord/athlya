/**
 * Contract between the log-based Axiom SLO monitors and the runtime
 * (issue #693).
 *
 * `infra/terraform/axiom-monitors.tf` filters log events on
 * `['message'] == "<label>"` and reads metric fields at the top level of
 * the event. The log pipeline (`workers/axiom-tail.ts`, issue #697)
 * delivers each console call's single structured argument as one Axiom
 * event, so this suite captures the console calls of the real emitters
 * and checks that every field a monitor references exists, at that path,
 * with a numeric value. `axiom-tail.test.ts` checks the shipped events
 * against the same contract (`helpers/axiom-log-contract.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetDlqRedisCache } from '../events/drain-dlq.js';

import {
  captureRuntimeEvents,
  expectMonitoredEvent,
  logMonitors,
} from './helpers/axiom-log-contract.js';

describe('Axiom log monitors ↔ runtime log events (issue #693)', () => {
  const monitors = logMonitors();
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

  for (const monitor of logMonitors()) {
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
        expectMonitoredEvent(monitor, event);
      }
    });
  }
});
