#!/usr/bin/env node
/**
 * Checklist — ClassCapacityDO scaling cap + fallback (issue #141 / P6).
 *
 * Usage: node scripts/verify-class-capacity-scaling-checklist.mjs
 */

const ITEMS = [
  {
    id: 'P6a',
    label: 'Cap abonnés WS par DO (CLASS_CAPACITY_MAX_WS, défaut 500, parse défensif)',
    doc: 'packages/api/src/durable-objects/class-capacity.ts',
  },
  {
    id: 'P6b',
    label: 'Shed > cap : 503 + X-Capacity-Fallback: poll + Retry-After',
    doc: 'ClassCapacityDO.fetch() upgrade branch',
  },
  {
    id: 'P6c',
    label: 'Limite + fallback + sharding documentés',
    doc: 'docs/runbooks/class-capacity-scaling.md',
  },
  {
    id: 'P6d',
    label: 'Tests cap/fallback + défaut sur env invalide verts',
    doc: 'pnpm --filter @athlya/api test -- src/__tests__/durable-objects/class-capacity.test.ts',
  },
  {
    id: 'P6e',
    label: 'Load test staging hot class (procédure documentée)',
    doc: 'docs/runbooks/class-capacity-scaling.md § Load test',
  },
];

console.log('ClassCapacityDO scaling checklist (issue #141 / P6)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
