#!/usr/bin/env node
/**
 * Post-deploy route smoke test — issue #301.
 *
 * Verifies that each route group is reachable and not returning 5xx after
 * a deploy. A 4xx (401/403/422) is a healthy response — it means the
 * sub-worker is up and the auth/validation chain is running. A 5xx or
 * connection error means something went wrong.
 *
 * Usage:
 *   node scripts/smoke-routes.mjs --base-url https://staging.api.athlya.app
 *
 * Exit 0 = all route groups healthy. Exit 1 = at least one failed.
 */

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
  },
});

const baseUrl = values['base-url'];
if (!baseUrl) {
  console.error('[smoke-routes] --base-url is required');
  process.exit(1);
}

const TIMEOUT_MS = 10_000;

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<number>} HTTP status code, or 0 on connection error
 */
async function probe(method, path, body) {
  const url = `${baseUrl}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status;
  } catch (err) {
    console.error(`[smoke-routes] ${method} ${path} → connection error: ${String(err)}`);
    return 0;
  }
}

const CHECKS = [
  // Health — must be 200 (or 503 if a binding is missing, but that's caught
  // by the wait-health-ready.sh step before we run this script).
  { name: 'health/ready', method: 'GET', path: '/health/ready', expectNot5xx: true, expect200: true },

  // Auth sub-worker — POST /v1/auth/login with missing body → 400/422
  { name: 'auth.login', method: 'POST', path: '/v1/auth/login', body: {}, expectNot5xx: true },

  // Reservations sub-worker — GET /v1/classes without JWT → 401
  { name: 'classes.list', method: 'GET', path: '/v1/classes', expectNot5xx: true },

  // Reservations sub-worker — GET /v1/reservations/me without JWT → 401
  { name: 'reservations.list', method: 'GET', path: '/v1/reservations/me', expectNot5xx: true },

  // Billing sub-worker — GET /v1/billing without JWT → 401/404
  { name: 'billing', method: 'GET', path: '/v1/billing/checkout', expectNot5xx: true },
];

let failed = false;

for (const check of CHECKS) {
  const status = await probe(check.method, check.path, check.body);

  if (status === 0) {
    console.error(`[smoke-routes] FAIL ${check.name}: connection error (timeout or refused)`);
    failed = true;
    continue;
  }

  if (check.expect200 && status !== 200) {
    console.error(`[smoke-routes] FAIL ${check.name}: expected 200, got ${status}`);
    failed = true;
    continue;
  }

  if (check.expectNot5xx && status >= 500) {
    console.error(`[smoke-routes] FAIL ${check.name}: got ${status} (5xx indicates sub-worker crash)`);
    failed = true;
    continue;
  }

  console.log(`[smoke-routes] OK   ${check.name}: HTTP ${status}`);
}

if (failed) {
  console.error('[smoke-routes] One or more route groups failed smoke check');
  process.exit(1);
}

console.log('[smoke-routes] All route groups healthy');
