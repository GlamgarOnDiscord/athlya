/**
 * Barrel export for `@athlya/billing`.
 *
 * Subpath imports (`@athlya/billing/service`, `@athlya/billing/webhook`)
 * are preferred in downstream packages because they let bundlers skip
 * unused modules entirely. This barrel exists so tests, scripts and
 * documentation examples can pull everything from a single import
 * without paying a noticeable bundle cost.
 *
 * Subpaths:
 *
 *   - `./service` — Stripe Checkout session creator (task 16.1).
 *   - `./webhook` — Stripe webhook handler with HMAC-SHA256 signature
 *                   verification (tasks 16.2 / 16.3).
 */

export * from './service.js';
export * from './webhook.js';
