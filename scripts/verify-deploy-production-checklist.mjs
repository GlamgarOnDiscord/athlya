#!/usr/bin/env node
/**
 * Deploy production workflow checklist (issue #130).
 */

const STEPS = [
  {
    id: 'D1',
    label: 'Secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID',
    doc: '.github/workflows/deploy-production.yml',
  },
  {
    id: 'D2',
    label: 'Vars STAGING_API_URL + PRODUCTION_API_URL',
    doc: 'docs/runbooks/deploy-production.md',
  },
  {
    id: 'D3',
    label: 'Environment GitHub production avec approbation',
    doc: 'docs/runbooks/deploy-production.md § Prérequis',
  },
  {
    id: 'D4',
    label: 'Workflow staging-deploy vert (wrangler + /health/ready)',
    doc: 'Actions → Deploy API → staging-deploy',
  },
  {
    id: 'D5',
    label: 'Gate ready testée : simuler not_ready → job fail',
    doc: 'scripts/wait-health-ready.sh',
  },
  {
    id: 'D6',
    label: 'production-deploy ou production-canary validé en rehearsal',
    doc: 'docs/runbooks/canary-deploy.md',
  },
];

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ issue: 130, steps: STEPS }, null, 2));
  process.exit(0);
}

console.log('Deploy production checklist (issue #130)\n');
console.log('Runbook: docs/runbooks/deploy-production.md\n');
for (const s of STEPS) {
  console.log(`[ ] ${s.id} — ${s.label}`);
  console.log(`    → ${s.doc}\n`);
}
