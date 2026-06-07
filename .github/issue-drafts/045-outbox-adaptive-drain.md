## Résumé

Cron outbox drain `* * * * *` (chaque minute), batch 100. Pas de backoff adaptatif si drain lent. Issue #72 = runbook — **pas de code adaptive**.

**Finding audit** : P4 — gravité **Medium**, priorité **P2**.

## Impact

- Charge DB constante même si queue vide
- Collision si drain > 60s
- Backlog spike non throttled

## Solution proposée

1. Métrique `outbox_pending_count` exposée (admin ou Axiom)
2. Drain interval adaptatif : skip si queue empty N cycles
3. Alerte backlog > seuil (coupler issue #90 Axiom)
4. Option : cron 30s si volume justifié

## Critères d'acceptation

- [ ] Métrique backlog visible
- [ ] Alerte configurée
- [ ] Pas de drain overlap (lock ou duration guard)
- [ ] Test charge backlog

## Références

- `docs/runbooks/outbox-ops.md`
- Issue fermée #72
- Audit prod 2026-05-27 — P4

## Priorité

**P2**
