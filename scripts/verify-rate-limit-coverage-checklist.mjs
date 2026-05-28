#!/usr/bin/env node
/**
 * Checklist — rate-limit coverage (issue #133).
 *
 * Usage: node scripts/verify-rate-limit-coverage-checklist.mjs
 */

const ITEMS = [
  {
    id: 'R1',
    label: 'Matrice docs/security/rate-limit-coverage.md alignée registry',
    doc: 'docs/security/rate-limit-coverage.md',
  },
  {
    id: 'R2',
    label: 'Registry rate-limit-policies.ts = source of truth',
    doc: 'packages/api/src/middleware/rate-limit-policies.ts',
  },
  {
    id: 'R3',
    label: 'Reads coûteux + admin stats fail-closed dans worker.ts',
    doc: 'packages/api/src/worker.ts',
  },
  {
    id: 'R4',
    label: 'Tests table-driven policies + Redis down',
    doc: 'pnpm --filter @athlya/api test -- src/__tests__/rate-limit-policies.test.ts',
  },
  {
    id: 'R5',
    label: 'WAF Cloudflare /v1/auth/* (defense-in-depth, dashboard)',
    doc: 'docs/security/audit-S4-network.md',
  },
];

console.log('Rate-limit coverage checklist (issue #133)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
