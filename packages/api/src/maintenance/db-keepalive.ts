/**
 * DB keepalive probe — issue #316 (Neon cold start mitigation).
 *
 * Neon serverless suspends compute after ~5 minutes of inactivity.
 * The outbox drain (runScheduledDrain) already touches DB_URL every
 * cron tick via countPendingOutbox, which in practice keeps Neon warm.
 * This module makes the keepalive intent explicit, measures round-trip
 * latency, and emits a structured metric so Axiom can alert when p95
 * crosses the 400ms threshold (indicating a cold start or degraded
 * compute).
 *
 * Long-term fix: set min_cu = 0.25 on the Neon project compute so the
 * Postgres process never fully suspends. See docs/runbooks/neon-min-cu.md.
 */

import type { CronSqlExecutor } from '../adapters/cron-sql-executor.js';

export interface DbKeepaliveResult {
  readonly latencyMs: number;
  readonly coldStartSuspected: boolean;
}

/** Latency threshold above which a Neon cold start is suspected. */
const COLD_START_THRESHOLD_MS = 400;

/**
 * Run a lightweight SELECT 1 against the DB executor and return the
 * measured round-trip latency. Logs a structured metric so Axiom /
 * Cloudflare Logpush can alert when p95 exceeds COLD_START_THRESHOLD_MS.
 *
 * Called on every cron tick from worker.ts. If the executor is null
 * (CRON_DB_URL absent in dev), the function is a no-op.
 */
export async function runDbKeepalive(
  executor: CronSqlExecutor,
  opts: { readonly label?: string } = {},
): Promise<DbKeepaliveResult> {
  const t0 = Date.now();
  await executor.selectRows<{ alive: number }>('SELECT 1 AS alive', []);
  const latencyMs = Date.now() - t0;
  const coldStartSuspected = latencyMs > COLD_START_THRESHOLD_MS;

  console.log('[worker] db_keepalive', {
    event: 'db_keepalive',
    label: opts.label ?? 'cron_db',
    latencyMs,
    coldStartSuspected,
    threshold_ms: COLD_START_THRESHOLD_MS,
  });

  if (coldStartSuspected) {
    console.warn('[worker] db_keepalive: cold start suspected', {
      event: 'db_cold_start_suspected',
      latencyMs,
      label: opts.label ?? 'cron_db',
      hint: 'Set min_cu=0.25 on the Neon project compute — see docs/runbooks/neon-min-cu.md',
    });
  }

  return { latencyMs, coldStartSuspected };
}
