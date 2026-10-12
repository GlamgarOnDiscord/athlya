#!/usr/bin/env node
/**
 * Post-deploy smoke for the web and studio Workers (issue #422).
 *
 * Real network only — no route interception. For each deployed app it
 * checks that the public pages render (200), that the per-request CSP
 * carries a nonce and forbids framing, that HSTS is set, and that the
 * same-origin auth route handlers execute (an anonymous refresh answers
 * 4xx, never 5xx). It finally checks the API the apps talk to.
 *
 * Usage:
 *   WEB_URL=https://staging.athlya.app STUDIO_URL=https://staging.studio.athlya.app \
 *   API_URL=https://staging.api.athlya.app node scripts/smoke-frontend.mjs
 */

const WEB_PAGES = ['/', '/login', '/register', '/forgot-password', '/classes', '/robots.txt'];
const STUDIO_PAGES = ['/login'];

export class SmokeError extends Error {}

function check(condition, message) {
  if (!condition) throw new SmokeError(message);
}

function checkSecurityHeaders(res, url) {
  const csp = res.headers.get('content-security-policy') ?? '';
  check(/'nonce-[A-Za-z0-9_-]{16,}'/u.test(csp), `${url}: CSP without a per-request nonce`);
  check(csp.includes(`frame-ancestors 'none'`), `${url}: CSP allows framing`);
  check(
    (res.headers.get('strict-transport-security') ?? '').includes('max-age='),
    `${url}: missing Strict-Transport-Security`,
  );
}

async function get(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, {
      redirect: 'manual',
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SmokeError(`${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function smokeApp({ name, baseUrl, pages, fetchImpl, log }) {
  for (const path of pages) {
    const url = new URL(path, baseUrl).toString();
    const res = await get(fetchImpl, url);
    check(res.status === 200, `${url}: HTTP ${String(res.status)} (expected 200)`);
    if (!path.endsWith('.txt')) checkSecurityHeaders(res, url);
    log(`[smoke-frontend] OK ${name} ${path}`);
  }
  // Route handlers run (and reach their config) without a session.
  const refresh = new URL('/api/auth/refresh', baseUrl).toString();
  const res = await get(fetchImpl, refresh, {
    method: 'POST',
    headers: { origin: new URL(baseUrl).origin, 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    res.status >= 400 && res.status < 500,
    `${refresh}: anonymous refresh answered HTTP ${String(res.status)} (expected 4xx)`,
  );
  log(`[smoke-frontend] OK ${name} anonymous refresh → ${String(res.status)}`);
}

/**
 * @param {{ webUrl?: string, studioUrl?: string, apiUrl?: string,
 *           fetchImpl?: typeof fetch, log?: (m: string) => void }} options
 */
export async function runFrontendSmoke({
  webUrl,
  studioUrl,
  apiUrl,
  fetchImpl = fetch,
  log = console.log,
}) {
  check(Boolean(webUrl) || Boolean(studioUrl), 'WEB_URL and/or STUDIO_URL is required');
  if (webUrl) await smokeApp({ name: 'web', baseUrl: webUrl, pages: WEB_PAGES, fetchImpl, log });
  if (studioUrl) {
    await smokeApp({ name: 'studio', baseUrl: studioUrl, pages: STUDIO_PAGES, fetchImpl, log });
  }
  if (apiUrl) {
    const health = new URL('/health', apiUrl).toString();
    const res = await get(fetchImpl, health);
    check(res.status === 200, `${health}: HTTP ${String(res.status)}`);
    log('[smoke-frontend] OK api /health');
  }
}

if (import.meta.main) {
  try {
    await runFrontendSmoke({
      webUrl: process.env.WEB_URL || undefined,
      studioUrl: process.env.STUDIO_URL || undefined,
      apiUrl: process.env.API_URL || undefined,
    });
    console.log('[smoke-frontend] all checks passed');
  } catch (err) {
    console.error(`[smoke-frontend] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
