#!/usr/bin/env node
/**
 * Verify Cloudflare Access blocks /admin/* at the edge (issue #121).
 *
 * Without an Access session cookie, requests must NOT reach the Worker
 * with a 200 JSON body — expect 403/302 from Cloudflare Access.
 *
 * Usage:
 *   ATHLYA_API_URL=https://api.athlya.app \
 *   ATHLYA_ADMIN_TOKEN=<jwt> \
 *   node scripts/smoke-cf-access-admin.mjs
 *
 * Optional:
 *   ADMIN_PATH=/admin/outbox/stats   (default)
 *   EXPECT_ACCESS=false              — skip (local dev without Access)
 */

const API = (process.env.ATHLYA_API_URL ?? 'https://api.athlya.app').replace(/\/$/, '');
const TOKEN = process.env.ATHLYA_ADMIN_TOKEN;
const PATH = process.env.ADMIN_PATH ?? '/admin/outbox/stats';
const EXPECT_ACCESS = process.env.EXPECT_ACCESS !== 'false';

if (!EXPECT_ACCESS) {
  console.log('[smoke-cf-access] skipped (EXPECT_ACCESS=false)');
  process.exit(0);
}

if (!TOKEN) {
  console.error('[smoke-cf-access] ATHLYA_ADMIN_TOKEN required (admin JWT, no Access cookie).');
  process.exit(1);
}

const url = `${API}${PATH.startsWith('/') ? PATH : `/${PATH}`}`;

const res = await fetch(url, {
  method: 'GET',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    accept: 'application/json',
  },
  redirect: 'manual',
});

const contentType = res.headers.get('content-type') ?? '';
const bodyText = await res.text();

console.log(`[smoke-cf-access] ${url}`);
console.log(`[smoke-cf-access] status=${res.status} content-type=${contentType}`);

const looksLikeWorkerJson =
  res.status === 200 &&
  contentType.includes('application/json') &&
  (bodyText.includes('"pending"') || bodyText.includes('"status"'));

if (looksLikeWorkerJson) {
  console.error(
    '[smoke-cf-access] FAIL: Worker returned 200 JSON with admin JWT but no Access cookie — CF Access not enforced.',
  );
  process.exit(1);
}

const blockedAtEdge =
  res.status === 403 ||
  res.status === 302 ||
  res.status === 401 ||
  bodyText.toLowerCase().includes('cloudflareaccess') ||
  res.headers.get('location')?.includes('cloudflareaccess') === true;

if (blockedAtEdge) {
  console.log('[smoke-cf-access] OK: request blocked at edge (Access or gateway).');
  process.exit(0);
}

console.error(
  `[smoke-cf-access] FAIL: unexpected response (status ${res.status}). Configure Access on ${API}/admin/* per docs/runbooks/admin-access.md`,
);
process.exit(1);
