#!/usr/bin/env node
/**
 * Print the 15 Axiom alert provisioning checklist (issues #120, #126, #132).
 * Operator ticks items in docs/runbooks/axiom-alerts-provision.md after UI setup.
 *
 * Usage:
 *   node scripts/verify-axiom-alerts-checklist.mjs
 *   node scripts/verify-axiom-alerts-checklist.mjs --json
 */

const ALERTS = [
  { id: 'A1', name: 'Error rate 5xx > 1% / 5m', sev: 2, route: 'Slack' },
  { id: 'A2', name: 'auth.login p95 > 200ms', sev: 3, route: 'Slack' },
  { id: 'A3', name: 'reservations.book p99 > 500ms', sev: 2, route: 'Slack + PagerDuty' },
  { id: 'A4', name: 'Queue lag p99 > 60s', sev: 2, route: 'Slack' },
  { id: 'A5', name: 'DLQ pending > 100', sev: 2, route: 'Slack' },
  { id: 'A6', name: 'Suspicious login spike', sev: 3, route: 'Slack' },
  { id: 'A7', name: 'Refresh token reuse', sev: 1, route: 'Slack + PagerDuty' },
  { id: 'A8', name: 'Concurrency 429 storm', sev: 3, route: 'Slack' },
  { id: 'A9', name: 'Boot config error', sev: 3, route: 'Slack' },
  { id: 'A10', name: 'HIBP unavailable', sev: 3, route: 'Slack' },
  { id: 'A11', name: 'S1 booking burn rate > 2x', sev: 2, route: 'Slack + PagerDuty' },
  { id: 'A12', name: 'S3 error burn rate > 2x', sev: 2, route: 'Slack + PagerDuty' },
  { id: 'A13', name: 'S4 queue lag burn rate > 2x', sev: 3, route: 'Slack' },
  { id: 'A14', name: 'QStash publish / quota stress', sev: 3, route: 'Slack' },
  { id: 'A15', name: 'Unknown queue event type', sev: 3, route: 'Slack' },
];

const json = process.argv.includes('--json');

if (json) {
  console.log(JSON.stringify({ count: ALERTS.length, alerts: ALERTS }, null, 2));
  process.exit(0);
}

console.log(`Axiom alerts provisioning checklist (${ALERTS.length} monitors)\n`);
console.log('Definitions: docs/operations/axiom-alerts.md');
console.log('Runbook:     docs/runbooks/axiom-alerts-provision.md\n');

for (const a of ALERTS) {
  console.log(`[ ] ${a.id} (Sev${a.sev}) ${a.name} → ${a.route}`);
}

console.log(`
Also required (non-Axiom):
[ ] Checkly CK2 — /health/ready 503 x2
[ ] Slack #ops-athlya-alerts webhook in Axiom

Test fires (min 3): T1 Checkly, T2 A1, T3 A5 — see runbook.
`);

if (ALERTS.length !== 15) {
  console.error('Expected 15 alerts');
  process.exit(1);
}
