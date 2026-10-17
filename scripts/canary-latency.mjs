/**
 * Latency gate for canary promotion — issue #415.
 *
 * At a partial traffic percentage most requests still land on the previous
 * version, so timing ordinary requests would mostly measure the old code.
 * Each probe therefore pins itself to the canary with Cloudflare's
 * `Cloudflare-Workers-Version-Overrides` header and checks that
 * `/health/ready` answers with the canary's `version` — proof that the
 * sample measured the new version.
 *
 * Scope: this is **readiness latency** — `/health/ready` runs the canary's
 * request pipeline plus live Postgres and Redis round-trips (R2 and cron
 * are configuration checks only). It catches a canary that is slow or
 * degraded as a whole, not a regression confined to one API route; the
 * per-route p95/p99 SLOs are watched by the Axiom monitors
 * (infra/terraform/axiom-monitors.tf).
 *
 * Any sample that is not a ready answer from the canary fails the gate
 * (fail-closed), as does a p95 above the threshold.
 */

/** Default p95 budget, measured from the CI runner (network included). */
export const DEFAULT_MAX_P95_MS = 1500;
export const DEFAULT_SAMPLES = 20;
const MIN_SAMPLES = 5;
const MAX_SAMPLES = 200;

/**
 * Nearest-rank percentile.
 *
 * @param {number[]} values
 * @param {number} p  0 < p <= 100
 * @returns {number} NaN for an empty input
 */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * @param {{ p95Ms: number, maxP95Ms: number }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateLatency({ p95Ms, maxP95Ms }) {
  if (!Number.isFinite(p95Ms)) {
    return { ok: false, reason: 'canary latency unavailable — failing closed' };
  }
  if (p95Ms > maxP95Ms) {
    return {
      ok: false,
      reason: `canary /health/ready p95 ${Math.round(p95Ms)} ms exceeds ${maxP95Ms} ms`,
    };
  }
  return {
    ok: true,
    reason: `canary /health/ready p95 ${Math.round(p95Ms)} ms within ${maxP95Ms} ms`,
  };
}

function parseBound(raw, fallback, min, max) {
  if (raw === undefined || raw === '') return { value: fallback };
  if (!/^\d+$/.test(raw)) return { error: true };
  const value = Number(raw);
  if (value < min || value > max) return { error: true };
  return { value };
}

/**
 * `CANARY_MAX_P95_MS` (default 1500) and `CANARY_LATENCY_SAMPLES`
 * (default 20, 5-200) are optional; an empty value (unset repository
 * variable) means the default, anything else that is not an integer in
 * range fails the configuration rather than silently falling back.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, config: { maxP95Ms: number, samples: number } } | { ok: false, invalid: string[] }}
 */
export function readLatencyConfig(env) {
  const maxP95 = parseBound(env.CANARY_MAX_P95_MS, DEFAULT_MAX_P95_MS, 1, 60_000);
  const samples = parseBound(env.CANARY_LATENCY_SAMPLES, DEFAULT_SAMPLES, MIN_SAMPLES, MAX_SAMPLES);
  const invalid = [
    ...(maxP95.error ? ['CANARY_MAX_P95_MS (integer 1-60000)'] : []),
    ...(samples.error ? [`CANARY_LATENCY_SAMPLES (integer ${MIN_SAMPLES}-${MAX_SAMPLES})`] : []),
  ];
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, config: { maxP95Ms: maxP95.value, samples: samples.value } };
}

/**
 * Time `samples` sequential `/health/ready` requests pinned to the canary.
 *
 * @param {{
 *   baseUrl: string,
 *   workerName: string,
 *   versionId: string,
 *   expectedVersion: string,
 *   samples: number,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ p95Ms: number, durations: number[], failures: string[] }>}
 *   `p95Ms` is NaN when any sample failed.
 */
export async function probeCanaryLatency({
  baseUrl,
  workerName,
  versionId,
  expectedVersion,
  samples,
  fetchImpl = fetch,
  now = () => performance.now(),
}) {
  const url = `${baseUrl.replace(/\/$/, '')}/health/ready`;
  const headers = {
    'cloudflare-workers-version-overrides': `${workerName}="${versionId}"`,
    'cache-control': 'no-store',
  };
  const durations = [];
  const failures = [];
  for (let i = 0; i < samples; i++) {
    const started = now();
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
      const body = await res.json().catch(() => ({}));
      const elapsed = now() - started;
      if (!res.ok || body?.status !== 'ready') {
        failures.push(`sample ${i + 1}: HTTP ${res.status} status=${body?.status ?? 'unknown'}`);
      } else if (body?.version !== expectedVersion) {
        failures.push(
          `sample ${i + 1}: served version ${String(body?.version)} instead of canary ${expectedVersion}`,
        );
      } else {
        durations.push(elapsed);
      }
    } catch (err) {
      failures.push(`sample ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    p95Ms: failures.length > 0 ? Number.NaN : percentile(durations, 95),
    durations,
    failures,
  };
}
