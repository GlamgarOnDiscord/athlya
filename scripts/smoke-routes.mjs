#!/usr/bin/env node
/**
 * Post-deploy route smoke test — issues #301, #343.
 *
 * Unauthenticated pass: every route group must be reachable and not
 * return 5xx. A 4xx (401/403/422) is a healthy response — it means the
 * sub-worker is up and the auth/validation chain is running.
 *
 * Authenticated pass (when credentials are provided): logs in as a
 * dedicated smoke account and requires 200 from routes that read the
 * migrated schema through the deployed artifacts. This is what proves
 * the deployed system rather than mere reachability.
 *
 * Usage:
 *   node scripts/smoke-routes.mjs --base-url https://staging.api.athlya.app
 *   SMOKE_EMAIL=… SMOKE_PASSWORD=… [SMOKE_TURNSTILE_TOKEN=…] [SMOKE_STUDIO_SLUG=…] \
 *     node scripts/smoke-routes.mjs --base-url … --require-auth
 *
 * `--require-auth` turns missing credentials into a failure (trusted
 * release contexts); without it the authenticated pass is skipped.
 *
 * `--session-file <path>` writes the access token (mode 0600) so a later
 * step can reuse this session: a Turnstile token is single-use, so a
 * second login with the same token would be rejected.
 *
 * Exit 0 = all checks healthy. Exit 1 = at least one failed.
 */

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const TIMEOUT_MS = 10_000;

/** `GET /v1/classes` requires `from`/`to`; the API caps the range at 90 days. */
const CLASS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const PUBLIC_CHECKS = [
  { name: 'health/ready', method: 'GET', path: '/health/ready', expect200: true },
  { name: 'auth.login', method: 'POST', path: '/v1/auth/login', body: {} },
  { name: 'classes.list', method: 'GET', path: '/v1/classes' },
  { name: 'reservations.list', method: 'GET', path: '/v1/reservations/me' },
  { name: 'billing', method: 'GET', path: '/v1/billing/checkout' },
];

/**
 * @param {{
 *   baseUrl: string,
 *   email?: string,
 *   password?: string,
 *   turnstileToken?: string,
 *   studioSlug?: string,
 *   requireAuth?: boolean,
 *   now?: () => Date,
 *   fetchImpl?: typeof fetch,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, failures: string[], accessToken?: string }>}
 */
export async function runSmoke({
  baseUrl,
  email,
  password,
  turnstileToken,
  studioSlug,
  requireAuth = false,
  now = () => new Date(),
  fetchImpl = fetch,
  log = console.log,
}) {
  const failures = [];

  async function request(method, path, { body, headers = {} } = {}) {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res;
    } catch (err) {
      log(`[smoke-routes] ${method} ${path} → connection error: ${String(err)}`);
      return null;
    }
  }

  function fail(name, reason) {
    failures.push(`${name}: ${reason}`);
    log(`[smoke-routes] FAIL ${name}: ${reason}`);
  }

  for (const check of PUBLIC_CHECKS) {
    const res = await request(check.method, check.path, { body: check.body });
    if (res === null) {
      fail(check.name, 'connection error (timeout or refused)');
    } else if (check.expect200 && res.status !== 200) {
      fail(check.name, `expected 200, got ${res.status}`);
    } else if (res.status >= 500) {
      fail(check.name, `got ${res.status} (5xx indicates sub-worker crash)`);
    } else {
      log(`[smoke-routes] OK   ${check.name}: HTTP ${res.status}`);
    }
  }

  if (!email || !password) {
    if (requireAuth) {
      fail('auth.credentials', 'SMOKE_EMAIL / SMOKE_PASSWORD not set but --require-auth was given');
    } else {
      log('[smoke-routes] SKIP authenticated pass (no SMOKE_EMAIL / SMOKE_PASSWORD)');
    }
    return { ok: failures.length === 0, failures };
  }

  const loginHeaders = turnstileToken ? { 'cf-turnstile-token': turnstileToken } : {};
  const login = await request('POST', '/v1/auth/login', {
    body: { email, password },
    headers: loginHeaders,
  });
  if (login === null || login.status !== 200) {
    fail(
      'auth.login (authenticated)',
      `expected 200, got ${login === null ? 'connection error' : login.status}`,
    );
    return { ok: false, failures };
  }
  const session = await login.json().catch(() => null);
  const accessToken = session && typeof session.accessToken === 'string' ? session.accessToken : '';
  if (!accessToken) {
    fail('auth.login (authenticated)', 'response has no accessToken');
    return { ok: false, failures };
  }
  log('[smoke-routes] OK   auth.login (authenticated): HTTP 200');

  const authHeaders = {
    authorization: `Bearer ${accessToken}`,
    ...(studioSlug ? { 'x-studio-slug': studioSlug } : {}),
  };
  const authChecks = [
    { name: 'members.me', path: '/v1/members/me' },
    { name: 'reservations.me', path: '/v1/reservations/me' },
    ...(studioSlug ? [{ name: 'classes.list (studio)', path: `/v1/classes?${classRange()}` }] : []),
  ];
  for (const check of authChecks) {
    const res = await request('GET', check.path, { headers: authHeaders });
    if (res === null || res.status !== 200) {
      fail(check.name, `expected 200, got ${res === null ? 'connection error' : res.status}`);
    } else {
      log(`[smoke-routes] OK   ${check.name}: HTTP 200`);
    }
  }

  return { ok: failures.length === 0, failures, accessToken };

  function classRange() {
    const from = now().getTime();
    return new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(from + CLASS_WINDOW_MS).toISOString(),
    });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      'require-auth': { type: 'boolean', default: false },
      'session-file': { type: 'string' },
    },
  });

  const baseUrl = values['base-url'];
  if (!baseUrl) {
    console.error('[smoke-routes] --base-url is required');
    process.exit(1);
  }

  const { ok, accessToken } = await runSmoke({
    baseUrl,
    email: process.env.SMOKE_EMAIL,
    password: process.env.SMOKE_PASSWORD,
    turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN,
    studioSlug: process.env.SMOKE_STUDIO_SLUG,
    requireAuth: values['require-auth'],
  });

  if (!ok) {
    console.error('[smoke-routes] One or more checks failed');
    process.exit(1);
  }
  if (values['session-file'] && accessToken) {
    await writeFile(values['session-file'], accessToken, { mode: 0o600 });
  }
  console.log('[smoke-routes] All checks healthy');
}
