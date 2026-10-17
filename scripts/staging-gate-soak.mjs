#!/usr/bin/env node
/**
 * k6 soak policy for the staging gate — issue #343.
 *
 * The release gate requires a 10-minute soak. Running it on every PR would
 * hold the shared staging environment for 10+ minutes per push, so:
 *
 *   pull_request       → short soak (2m), smoke-level signal only
 *   push to master     → full soak (10m), the run production deploys trust
 *   workflow_dispatch  → `soak_duration` input (default 10m); full when ≥ 10m
 *
 * Production only promotes a SHA whose "Staging gate (full soak)" check
 * succeeded. That job runs only when `verify` measured a k6 run of at least
 * FULL_SOAK_MINUTES from k6's own end-of-test summary.
 *
 * Usage (GitHub Actions):
 *   node scripts/staging-gate-soak.mjs resolve --event "$GITHUB_EVENT_NAME" --input "$SOAK_INPUT"
 *   node scripts/staging-gate-soak.mjs verify --summary k6-book-class-summary.json --min-minutes 10
 *
 * Both subcommands append `key=value` lines to $GITHUB_OUTPUT when it is set.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const FULL_SOAK_MINUTES = 10;
export const PR_SOAK_MINUTES = 2;
/** Upper bound for manual runs: the gate job has a 60-minute timeout. */
export const MAX_SOAK_MINUTES = 30;

/**
 * @param {{ event: string, input?: string }} options
 * @returns {{ ok: true, duration: string, minutes: number, full: boolean } | { ok: false, reason: string }}
 */
export function resolveSoak({ event, input }) {
  if (event === 'pull_request') {
    return { ok: true, duration: `${PR_SOAK_MINUTES}m`, minutes: PR_SOAK_MINUTES, full: false };
  }
  if (event === 'push') {
    return { ok: true, duration: `${FULL_SOAK_MINUTES}m`, minutes: FULL_SOAK_MINUTES, full: true };
  }
  if (event === 'workflow_dispatch') {
    const raw = (input ?? '').trim() || `${FULL_SOAK_MINUTES}m`;
    const match = /^([1-9]\d*)m$/u.exec(raw);
    if (!match) {
      return { ok: false, reason: `soak_duration must be whole minutes like "10m", got "${raw}"` };
    }
    const minutes = Number(match[1]);
    if (minutes > MAX_SOAK_MINUTES) {
      return {
        ok: false,
        reason: `soak_duration must be at most ${MAX_SOAK_MINUTES}m, got "${raw}"`,
      };
    }
    return { ok: true, duration: raw, minutes, full: minutes >= FULL_SOAK_MINUTES };
  }
  return { ok: false, reason: `unsupported event "${event}"` };
}

/**
 * Check that a k6 end-of-test summary (handleSummary data) covers at least
 * `minMinutes` of test run time. `state.testRunDurationMs` is measured by
 * k6 itself, so a shortened or aborted run cannot pass as a full soak.
 *
 * @param {unknown} summary
 * @param {number} minMinutes
 * @returns {{ ok: boolean, reason: string, durationMs?: number }}
 */
export function evaluateSoak(summary, minMinutes) {
  const durationMs = /** @type {{ state?: { testRunDurationMs?: unknown } } | null} */ (summary)
    ?.state?.testRunDurationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return { ok: false, reason: 'k6 summary has no numeric state.testRunDurationMs' };
  }
  const requiredMs = minMinutes * 60_000;
  const measured = `${(durationMs / 60_000).toFixed(1)}m`;
  if (durationMs < requiredMs) {
    return {
      ok: false,
      durationMs,
      reason: `k6 ran ${measured}, below the ${minMinutes}m full soak`,
    };
  }
  return { ok: true, durationMs, reason: `k6 ran ${measured} (≥ ${minMinutes}m)` };
}

/** @param {Record<string, string>} outputs */
function writeOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`);
  if (file) appendFileSync(file, lines.join(''));
  for (const line of lines) process.stdout.write(line);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      event: { type: 'string' },
      input: { type: 'string' },
      summary: { type: 'string' },
      'min-minutes': { type: 'string' },
    },
  });

  if (command === 'resolve') {
    const result = resolveSoak({ event: values.event ?? '', input: values.input });
    if (!result.ok) {
      console.error(`::error title=Invalid soak duration::${result.reason}`);
      process.exit(1);
    }
    writeOutputs({
      duration: result.duration,
      minutes: String(result.minutes),
      full: String(result.full),
    });
  } else if (command === 'verify') {
    const minMinutes = Number(values['min-minutes'] ?? FULL_SOAK_MINUTES);
    if (!values.summary || !Number.isInteger(minMinutes) || minMinutes <= 0) {
      console.error('[staging-gate-soak] verify needs --summary and a positive --min-minutes');
      process.exit(1);
    }
    let summary;
    try {
      summary = JSON.parse(readFileSync(values.summary, 'utf8'));
    } catch (err) {
      console.error(`::error title=k6 summary unreadable::${String(err)}`);
      process.exit(1);
    }
    const result = evaluateSoak(summary, minMinutes);
    if (!result.ok) {
      console.error(`::error title=Full soak not proven::${result.reason}`);
      process.exit(1);
    }
    console.log(`[staging-gate-soak] OK — ${result.reason}`);
    writeOutputs({
      verified: 'true',
      measured_minutes: ((result.durationMs ?? 0) / 60_000).toFixed(1),
    });
  } else {
    console.error(
      '[staging-gate-soak] usage: resolve --event <name> [--input <dur>] | verify --summary <file> [--min-minutes <n>]',
    );
    process.exit(1);
  }
}
