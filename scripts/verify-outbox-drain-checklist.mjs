#!/usr/bin/env node
/**
 * Checklist — outbox drain adaptatif + backlog metric (issue #134).
 *
 * Usage: node scripts/verify-outbox-drain-checklist.mjs
 */

const ITEMS = [
  {
    id: 'O1',
    label:
      'Batch adaptatif (100 → 500 si pending > 500, OUTBOX_DRAIN_BATCH_SIZE ≤ 1000), snapshot pending queried 1×/cycle',
    doc: 'packages/api/src/events/drain-scheduled.ts',
  },
  {
    id: 'O2',
    label: 'Métrique outbox_pending_count émise à chaque tick (console, non gated logger)',
    doc: 'console.log "outbox.backlog" dans runScheduledDrain',
  },
  {
    id: 'O3',
    label: 'Overlap guard: warn outbox.drain_overlap_risk si durée > 45s (SKIP LOCKED = correct)',
    doc: 'warnOnDrainOverlapRisk()',
  },
  {
    id: 'O4',
    label: 'Tests batch/metric/overlap/runScheduledDrain verts',
    doc: 'pnpm --filter @athlya/api test -- src/__tests__/drain-scheduled-batch.test.ts',
  },
  {
    id: 'O5',
    label: 'Alerte Axiom A16 provisionnée (backlog > 500 / 5min OU overlap)',
    doc: 'docs/operations/axiom-alerts.md § A16',
  },
  {
    id: 'O6',
    label: 'Admin GET /admin/outbox/stats reste la source de vérité backlogAlertRecommended',
    doc: 'packages/api/src/admin/outbox-routes.ts',
  },
  {
    id: 'O7',
    label: 'Runbook outbox-ops relu (cadence, overlap, queries A16)',
    doc: 'docs/runbooks/outbox-ops.md',
  },
  {
    id: 'O8',
    label:
      'Outbox kick queue athlya-outbox-kick(-staging) created; outbox.kick_drain logged after a write (issue #311)',
    doc: 'docs/runbooks/outbox-ops.md § Outbox kick',
  },
];

console.log('Outbox drain adaptatif checklist (issue #134)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
