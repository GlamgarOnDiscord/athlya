#!/usr/bin/env node
/**
 * Checklist — unknown queue event handling (issue #132).
 *
 * Usage: node scripts/verify-unknown-queue-event-checklist.mjs
 */

const ITEMS = [
  {
    id: 'U1',
    label: 'rejectUnknownQueueEvent → EVENTS_DLQ + metric log',
    doc: 'packages/api/src/events/reject-unknown-queue-event.ts',
  },
  {
    id: 'U2',
    label: 'ALL_KNOWN_EVENT_TYPES inclut notifications + RGPD',
    doc: 'packages/api/src/events/known-event-types.ts',
  },
  {
    id: 'U3',
    label: 'Tests reject-unknown + queue-cascade unknown branch',
    doc: 'pnpm --filter @athlya/api test -- src/__tests__/reject-unknown-queue-event.test.ts',
  },
  {
    id: 'U4',
    label: 'Monitor Axiom A15 provisionné',
    doc: 'docs/operations/axiom-alerts.md § A15',
  },
  {
    id: 'U5',
    label: 'Runbook event-bus § types inconnus relu',
    doc: 'docs/runbooks/event-bus.md',
  },
];

console.log('Unknown queue event checklist (issue #132)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
