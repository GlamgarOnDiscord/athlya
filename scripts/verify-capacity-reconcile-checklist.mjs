#!/usr/bin/env node
/**
 * Checklist — capacity drift reconciliation (issue #135).
 *
 * Usage: node scripts/verify-capacity-reconcile-checklist.mjs
 */

const ITEMS = [
  {
    id: 'C1',
    label: 'reconcileCapacityDrift: expected = max(0, capacity - confirmed), seed clé manquante',
    doc: 'packages/reservations/src/reconcile.ts',
  },
  {
    id: 'C2',
    label: 'Auto-heal reset(Redis = PG) sur drift, isolation par classe (healFailures)',
    doc: 'reconcileCapacityDrift / autoHeal',
  },
  {
    id: 'C3',
    label: 'Métrique capacity_redis_pg_drift (log capacity.drift, direction oversell/false_full)',
    doc: 'CAPACITY_DRIFT_METRIC',
  },
  {
    id: 'C4',
    label: 'Runner cron wiring: CRON_DB_URL (BYPASSRLS) + REDIS_URL/TOKEN requis, sinon skip',
    doc: 'packages/api/src/maintenance/capacity-reconcile-runner.ts + worker.ts scheduled',
  },
  {
    id: 'C5',
    label: 'Tests drift/seed/heal/failures verts (reservations + api runner)',
    doc: 'pnpm --filter @athlya/reservations test -- src/__tests__/reconcile.test.ts',
  },
  {
    id: 'C6',
    label: 'Alerte Axiom A17 provisionnée (drift persistant > 5min)',
    doc: 'docs/operations/axiom-alerts.md § A17',
  },
  {
    id: 'C7',
    label: 'Runbook incident drift relu (race transitoire vs persistant, reset manuel)',
    doc: 'docs/runbooks/capacity-drift.md',
  },
  {
    id: 'C8',
    label: 'Test charge staging: injecter drift → vérifier heal sur 1 tick',
    doc: 'docs/runbooks/capacity-drift.md § Test charge',
  },
];

console.log('Capacity drift reconciliation checklist (issue #135)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
