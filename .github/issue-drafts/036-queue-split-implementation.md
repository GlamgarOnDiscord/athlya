## Résumé

Une queue `athlya-events` + `handleEventsBatch` en **`for` séquentiel** (`worker.ts` ~L1448). Export ZIP lent **bloque** notifications dans le même batch. ADR split queues dans `event-bus.md` §6 — **non implémenté**.

**Finding audit** : A4 — gravité **High**, priorité **P1**.

Issue #81 fermée (ADR doc) — **code inchangé**.

## Comportement observé

```typescript
// worker.ts — pattern séquentiel
for (const msg of batch.messages) {
  switch (event.type) { ... }
}
```

Un `members.export.requested` long retarde `reservation.created` emails.

## Impact production

- Latence emails/push multipliée par durée export
- Backlog queue invisible jusqu'à DLQ
- Blast radius **domaine entier** (SPOF logique)

## Solution proposée

### Phase 1 — Queues séparées (cf. ADR)

| Queue                         | Events                                         |
| ----------------------------- | ---------------------------------------------- |
| `athlya-events-notifications` | `reservation.*`, `billing.subscription.failed` |
| `athlya-events-rgpd`          | `auth.user.deleted`, `members.export.*`        |
| `athlya-events-billing`       | futur analytics                                |

### Phase 2 — wrangler.toml

Bindings queue par env + producers outbox drain routés.

### Phase 3 — Consumers

Handlers séparés ou `waitUntil` par message avec concurrency cap.

### Phase 4 — Migration

Dual-write période transition ou drain backlog avant cutover.

## Composants touchés

- [ ] `packages/api/wrangler.toml` — queue bindings
- [ ] `packages/api/src/worker.ts` — dispatch
- [ ] Outbox drain — routing par event type
- [ ] `docs/runbooks/event-bus.md` §6

## Critères d'acceptation

- [ ] Export long n'impacte pas latence notification (test charge)
- [ ] Métrique lag par queue
- [ ] DLQ par queue ou prefix
- [ ] Runbook migration documenté

## Références

- `docs/runbooks/event-bus.md` §6
- `packages/api/src/worker.ts`
- Issue fermée #81 (ADR only)
- Audit prod 2026-05-27 — A4

## Priorité

**P1** — avant >1k events/jour ou 2e studio
