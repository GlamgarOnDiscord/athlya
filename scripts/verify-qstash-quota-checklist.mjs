#!/usr/bin/env node
/**
 * QStash quota provisioning checklist (issue #126).
 *
 * Usage:
 *   node scripts/verify-qstash-quota-checklist.mjs
 *   node scripts/verify-qstash-quota-checklist.mjs --json
 */

const STEPS = [
  {
    id: 'Q1',
    label: 'Alerte Upstash QStash 80% quota journalier (email/Slack)',
    doc: 'docs/runbooks/qstash-quota.md § Étape 1',
  },
  {
    id: 'Q2',
    label: 'Monitor Axiom A14 (qstash.publish.failed / quota.degraded)',
    doc: 'docs/operations/axiom-alerts.md § A14',
  },
  {
    id: 'Q3',
    label: 'Ligne QStash dans cost-monitoring.md relue (seuil 5 studios)',
    doc: 'docs/runbooks/cost-monitoring.md',
  },
  {
    id: 'Q4',
    label: 'Test staging: log qstash.schedule.skipped visible (tail ou Axiom)',
    doc: 'docs/runbooks/qstash-quota.md § Test staging',
  },
  {
    id: 'Q5',
    label: 'Décision tier payant documentée si ≥2 studios pilotes',
    doc: 'docs/runbooks/qstash-quota.md § Charge projetée',
  },
  {
    id: 'Q6',
    label: 'Escalation Sev1–Sev3 comprise par on-call',
    doc: 'docs/runbooks/qstash-quota.md § Escalation',
  },
  {
    id: 'Q7',
    label: 'Launch checklist v1.0.0 bloc QStash coché',
    doc: 'docs/operations/v1.0.0-launch-checklist.md',
  },
];

const json = process.argv.includes('--json');

if (json) {
  console.log(JSON.stringify({ count: STEPS.length, steps: STEPS }, null, 2));
  process.exit(0);
}

console.log(`QStash quota checklist (${STEPS.length} items)\n`);
console.log('Runbook: docs/runbooks/qstash-quota.md\n');

for (const s of STEPS) {
  console.log(`[ ] ${s.id} ${s.label}`);
  console.log(`    → ${s.doc}`);
}

console.log(`
Projection 5 studios: ~1000+ msg/j → tier payant obligatoire (voir runbook).
`);

if (STEPS.length !== 7) {
  console.error('Expected 7 steps');
  process.exit(1);
}
