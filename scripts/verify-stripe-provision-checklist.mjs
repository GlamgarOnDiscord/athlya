#!/usr/bin/env node
/**
 * Stripe production provisioning checklist (issue #122).
 */

const STEPS = [
  'Migration 0010_stripe_webhook_events.sql applied on Neon',
  'STRIPE_SECRET_KEY set (wrangler staging)',
  'STRIPE_WEBHOOK_SECRET set (wrangler staging)',
  'STRIPE_SECRET_KEY set (wrangler production)',
  'STRIPE_WEBHOOK_SECRET set (wrangler production)',
  'Stripe webhook endpoint registered (staging URL)',
  'Stripe webhook endpoint registered (production URL)',
  'node scripts/smoke-stripe-webhook-config.mjs exit 0 (staging)',
  'Checkout E2E with admin JWT (staging)',
  'Webhook replay same event.id idempotent (staging)',
];

console.log('Stripe production checklist (issue #122)\n');
console.log('Runbook: docs/runbooks/stripe-production.md\n');
for (const s of STEPS) {
  console.log(`[ ] ${s}`);
}
