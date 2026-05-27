#!/usr/bin/env node
/**
 * Calls POST /admin/jwt/rotate-prepare and prints wrangler secret commands.
 *
 * Usage:
 *   ATHLYA_ADMIN_TOKEN=<jwt> WRANGLER_ENV=staging node scripts/rotate-jwt-prepare.mjs
 *
 * Optional:
 *   ATHLYA_API_URL=https://staging.api.athlya.app  (default)
 *   ROTATION_JSON=./rotation.json                 (write response)
 *
 * Does NOT run wrangler — operator reviews output then executes manually.
 * See docs/runbooks/rotate-jwt.md.
 */

const API = (process.env.ATHLYA_API_URL ?? 'https://api.athlya.app').replace(/\/$/, '');
const TOKEN = process.env.ATHLYA_ADMIN_TOKEN;
const ENV = process.env.WRANGLER_ENV ?? 'staging';
const OUT = process.env.ROTATION_JSON;

if (!TOKEN) {
  console.error('ATHLYA_ADMIN_TOKEN is required (admin JWT).');
  process.exit(1);
}

const url = `${API}/admin/jwt/rotate-prepare`;
const res = await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
});

if (!res.ok) {
  const text = await res.text();
  console.error(`rotate-prepare failed: HTTP ${res.status}\n${text}`);
  process.exit(1);
}

const body = await res.json();

if (OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, JSON.stringify(body, null, 2), 'utf8');
  console.error(`Wrote ${OUT} — delete after secrets are applied.`);
}

const jwksOneLine = JSON.stringify(body.jwks);

console.log(`
# JWT rotation prepare — ${ENV}
# previousNotAfter: ${body.previousNotAfter} (grace ${body.graceSec}s)
# previousKid (demoted): ${body.previousKid}

# 1. Backup CURRENT keys to *_PREVIOUS before overwriting (use your secure copy):
#    wrangler secret put JWT_KID_PREVIOUS --env ${ENV}
#    wrangler secret put JWT_PRIVATE_KEY_PEM_PREVIOUS --env ${ENV}
#    wrangler secret put JWT_PUBLIC_KEY_PEM_PREVIOUS --env ${ENV}

# 2. New current (paste PEM from rotation JSON / ${OUT ?? 'stdout'}):
#    wrangler secret put JWT_KID --env ${ENV}  # value: ${body.currentKid}

# 3. JWKS (both keys during grace):
#    wrangler secret put JWKS_JSON --env ${ENV}

# 4. Redeploy:
#    cd packages/api && wrangler deploy --env ${ENV}

# 5. After ${body.previousNotAfter}, delete *_PREVIOUS secrets.

currentKid=${body.currentKid}
previousKid=${body.previousKid}
jwksBytes=${jwksOneLine.length}
`);
