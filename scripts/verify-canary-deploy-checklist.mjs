#!/usr/bin/env node
/**
 * Canary deploy provisioning checklist (issue #129).
 *
 * Usage:
 *   node scripts/verify-canary-deploy-checklist.mjs
 *   node scripts/verify-canary-deploy-checklist.mjs --json
 */

const STEPS = [
  {
    id: 'C1',
    label: 'Workers Paid + gradual deployments activés sur le compte CF',
    doc: 'docs/runbooks/canary-deploy.md § Prérequis',
  },
  {
    id: 'C2',
    label: 'Secrets GitHub CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID',
    doc: '.github/workflows/deploy-production.yml header',
  },
  {
    id: 'C3',
    label: 'Vars STAGING_API_URL + PRODUCTION_API_URL (sans slash final)',
    doc: '.github/workflows/deploy-production.yml',
  },
  {
    id: 'C4',
    label: 'Environment GitHub production avec approbation manuelle',
    doc: 'docs/runbooks/canary-deploy.md § CI',
  },
  {
    id: 'C5',
    label: 'Workflow dispatch staging-smoke vert (upload + /health/ready)',
    doc: 'Actions → Deploy (canary) → staging-smoke',
  },
  {
    id: 'C6',
    label: 'Production canary 5→25→100 exécuté ou dry-run staging traffic split validé',
    doc: 'docs/runbooks/canary-deploy.md § Production',
  },
  {
    id: 'C7',
    label: 'Rollback production testé < 5 min (workflow rollback ou wrangler rollback)',
    doc: 'docs/runbooks/canary-deploy.md § Rollback',
  },
  {
    id: 'C8',
    label: 'Launch checklist bloc canary / rollback relu',
    doc: 'docs/operations/v1.0.0-launch-checklist.md',
  },
];

const json = process.argv.includes('--json');

if (json) {
  console.log(JSON.stringify({ issue: 129, steps: STEPS }, null, 2));
  process.exit(0);
}

console.log('Canary deploy checklist (issue #129)\n');
console.log('Runbook: docs/runbooks/canary-deploy.md');
console.log('Workflow: .github/workflows/deploy-production.yml\n');
for (const step of STEPS) {
  console.log(`[ ] ${step.id} — ${step.label}`);
  console.log(`    → ${step.doc}\n`);
}
