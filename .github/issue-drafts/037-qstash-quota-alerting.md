## Résumé

Stack README annonce **QStash** pour reminders. Free tier Upstash/QStash **500 msg/j** (`critique.md`). Scheduler rappels 1h avant cours → saturation silencieuse possible.

**Finding audit** : A5 — gravité **Medium–High**, priorité **P1 commercial**.

## Comportement attendu

- Dashboard quota QStash/Upstash monitoré
- Alerte à 80% quota journalier
- Tier payant ou batch reminders dès 2e studio
- Fallback si quota dépassé (log + métrique, pas silence)

## Comportement observé

Pas d'alerte quota branchée. Rappels non envoyés sans notification ops.

## Solution proposée

1. Upstash console → alerte usage QStash
2. Métrique Worker `qstash_publish_total` + `qstash_publish_failed`
3. Batch reminders : grouper par créneau si > N cours/h
4. Documenter seuil upgrade plan dans `cost-monitoring.md`

## Critères d'acceptation

- [ ] Alerte quota configurée
- [ ] Test dépassement simulé sur staging
- [ ] Runbook escalation quota
- [ ] Coût projeté 5 studios documenté

## Références

- `docs/critique.md` (QStash quota)
- `docs/runbooks/cost-monitoring.md`
- Audit prod 2026-05-27 — A5

## Priorité

**P1 commercial** — dès trafic rappels réel
