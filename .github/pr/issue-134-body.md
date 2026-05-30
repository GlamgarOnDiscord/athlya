## Contexte

Issue #134 (P2). Le batch adaptatif (100 → 200 si `pending > 500`) et l'endpoint `GET /admin/outbox/stats` existaient déjà (issue #72). Cette PR ferme les vrais gaps : observabilité backlog côté cron, guard anti-overlap, alerte.

## Changements

- **Métrique backlog à chaque tick** : `runScheduledDrain` émet `outbox.backlog` (`metric: outbox_pending_count`, `pending`, `ageMs`, `batchSize`, `backlog`) via `console.log` **inconditionnellement** — avant, le snapshot n'était loggé que si un `Logger` était câblé, ce que le handler scheduled prod ne fait pas. Axiom a donc toujours un point.
- **Snapshot unique** : `countPendingOutbox` était appelé 2×/cycle (sizing + log). Désormais 1 seule requête réutilisée. `pickBatchSize()` extrait pour réutilisation.
- **Overlap guard** : `warnOnDrainOverlapRisk` émet `outbox.drain_overlap_risk` (`metric: outbox_drain_duration_ms`) si un cycle dépasse `OUTBOX_DRAIN_OVERLAP_WARN_MS = 45_000`. Pas de lock distribué : le `FOR UPDATE SKIP LOCKED` rend déjà l'overlap **correct**, c'est un signal de charge.
- **Alerte A16** + queries Axiom (backlog > 500 / 5min OU overlap).
- **Fix régression #133** : `AUTH_BUDGET` typé `as const satisfies` — `worker.ts` ne typecheckait plus (`ipLimit: number | undefined` sous `exactOptionalPropertyTypes`).
- Tests (10 nouveaux), runbook `outbox-ops.md`, `verify-outbox-drain-checklist.mjs`.

## Critères d'acceptation

- [x] Métrique backlog visible (chaque tick, Axiom)
- [x] Alerte configurée (A16)
- [x] Pas de drain overlap non géré (SKIP LOCKED + duration guard + métrique)
- [x] Test charge backlog (runScheduledDrain adaptive + métrique)

## Hors scope (noté runbook)

Skip "N cycles vides" : exigerait un état KV/Redis cross-invocation. Le batch adaptatif + early-return sur batch vide throttlent déjà.

Closes #134
