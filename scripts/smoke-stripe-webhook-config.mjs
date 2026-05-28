#!/usr/bin/env node
/**
 * Smoke: POST /v1/billing/webhook posture (issue #122).
 *
 * Without a valid Stripe-Signature, staging/production must NOT return
 * 200 with an empty body when STRIPE_WEBHOOK_SECRET is missing (500 config).
 * With secret configured, expect 400 signature_invalid.
 *
 * Usage:
 *   ATHLYA_API_URL=https://staging.api.athlya.app node scripts/smoke-stripe-webhook-config.mjs
 */

const API = (process.env.ATHLYA_API_URL ?? 'https://staging.api.athlya.app').replace(/\/$/, '');
const url = `${API}/v1/billing/webhook`;

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'stripe-signature': 't=0,v1=invalid_smoke_test',
  },
  body: JSON.stringify({ id: 'evt_smoke', type: 'checkout.session.completed' }),
});

const text = await res.text();
console.log(`[smoke-stripe] ${url}`);
console.log(`[smoke-stripe] status=${res.status} body=${text.slice(0, 200)}`);

if (res.status === 200 && text === '') {
  console.error('[smoke-stripe] FAIL: 200 no-op — webhook fail-open (secret missing in non-dev?)');
  process.exit(1);
}

if (res.status === 500 && text.includes('configuration_error')) {
  console.log('[smoke-stripe] OK: fail-closed configuration_error (secrets not provisioned yet).');
  process.exit(0);
}

if (res.status === 400) {
  console.log('[smoke-stripe] OK: signature rejected (secrets likely provisioned).');
  process.exit(0);
}

console.error(`[smoke-stripe] FAIL: unexpected status ${res.status}`);
process.exit(1);
