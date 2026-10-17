/**
 * Error-budget gate for canary promotion — issue #404.
 *
 * During each bake window the canary must prove more than "/health/ready
 * is green": route-level smoke checks must pass and the new release must
 * not burn the error budget. The error signal is the Sentry error count
 * for the canary release (the Worker tags every event with
 * `release = VERSION`, which the canary upload sets to the commit SHA).
 */

/**
 * @param {{ errorCount: number, maxErrors: number }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateErrorBudget({ errorCount, maxErrors }) {
  if (!Number.isFinite(errorCount)) {
    return { ok: false, reason: 'Sentry error count unavailable — failing closed' };
  }
  if (errorCount > maxErrors) {
    return {
      ok: false,
      reason: `${errorCount} errors for this release exceed the budget of ${maxErrors}`,
    };
  }
  return { ok: true, reason: `${errorCount} errors within the budget of ${maxErrors}` };
}

/**
 * Count Sentry error events for `release` between `start` and `end`.
 * Returns NaN when the API call fails so the caller fails closed.
 *
 * @param {{
 *   org: string,
 *   project: string,
 *   release: string,
 *   start: Date,
 *   end: Date,
 *   token: string,
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<number>}
 */
export async function fetchReleaseErrorCount({
  org,
  project,
  release,
  start,
  end,
  token,
  baseUrl = 'https://sentry.io',
  fetchImpl = fetch,
}) {
  const params = new URLSearchParams({
    field: 'count()',
    query: `event.type:error release:"${release}" project:${project}`,
    start: start.toISOString(),
    end: end.toISOString(),
    dataset: 'errors',
  });
  try {
    const res = await fetchImpl(`${baseUrl}/api/0/organizations/${org}/events/?${params}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return Number.NaN;
    const body = await res.json();
    const count = Number(body?.data?.[0]?.['count()']);
    return Number.isFinite(count) ? count : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * Read the gate configuration from the environment. Every value is
 * required: a canary without an error signal must not promote.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true, config: { org: string, project: string, token: string, release: string, maxErrors: number } } | { ok: false, missing: string[] }}
 */
export function readErrorBudgetConfig(env) {
  const required = {
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    token: env.SENTRY_AUTH_TOKEN,
    release: env.VERSION,
  };
  const names = {
    org: 'SENTRY_ORG',
    project: 'SENTRY_PROJECT',
    token: 'SENTRY_AUTH_TOKEN',
    release: 'VERSION',
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => names[key]);
  if (missing.length > 0) return { ok: false, missing };
  const maxErrors = Number(env.CANARY_MAX_ERRORS ?? 5);
  return {
    ok: true,
    config: {
      org: required.org,
      project: required.project,
      token: required.token,
      release: required.release,
      maxErrors: Number.isFinite(maxErrors) && maxErrors >= 0 ? maxErrors : 5,
    },
  };
}
