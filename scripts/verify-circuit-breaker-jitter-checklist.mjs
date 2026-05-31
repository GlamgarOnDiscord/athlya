#!/usr/bin/env node
/**
 * Checklist — circuit breaker half-open jitter + transition hook (issue #140 / R1).
 *
 * Usage: node scripts/verify-circuit-breaker-jitter-checklist.mjs
 */

const ITEMS = [
  {
    id: 'R1a',
    label: 'Jitter half-open per-isolate (défaut 20% resetTimeoutMs), tiré frais par trip',
    doc: 'packages/api/src/circuit-breaker.ts → tripOpen()/maybeTransitionFromOpen()',
  },
  {
    id: 'R1b',
    label: 'random injectable + resetJitterMs configurable, resetJitterMs < 0 rejeté',
    doc: 'CircuitBreakerOptions.random / resetJitterMs',
  },
  {
    id: 'R1c',
    label: 'Hook onTransition (métrique transitions état), best-effort exceptions avalées',
    doc: 'CircuitBreakerOptions.onTransition / emitTransition()',
  },
  {
    id: 'R1d',
    label: 'Invariant 1 probe/isolate/fenêtre conservé (probeInFlight inchangé)',
    doc: 'tests isolate independence + half-open jitter',
  },
  {
    id: 'R1e',
    label: 'Tests jitter + onTransition verts',
    doc: 'pnpm --filter @athlya/api test -- src/__tests__/circuit-breaker.test.ts',
  },
  {
    id: 'R1f',
    label: 'ADR ré-évalué post-audit R1 (décision, critères acceptation)',
    doc: 'docs/security/circuit-breaker-adr.md',
  },
];

console.log('Circuit breaker jitter + transition hook checklist (issue #140 / R1)\n');
for (const item of ITEMS) {
  console.log(`[ ] ${item.id} — ${item.label}`);
  console.log(`    → ${item.doc}\n`);
}
