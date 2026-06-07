## Résumé

`docs/operations/v1.0.0-launch-checklist.md` exige **13 alertes Axiom** armées (DLQ, outbox backlog, error rate, SLO booking, etc.). Aucune n'est provisionnée dans le dashboard Axiom — documentation seulement.

**Finding audit** : O3 — gravité **Critical** (ops), priorité **P0**.

Issue #72 (outbox doc) et #82 (cost runbook) fermées — **alertes non créées**.

## Comportement attendu

- 13 monitors Axiom actifs avec destinations Slack/PagerDuty
- Alertes silencieuses 7 jours avant go-live studio (checklist Phase A)
- Runbook par alerte : seuil, action, escalation

## Comportement observé

Checklist Jour 0→7 :

> ✅ Les 13 alertes Axiom + Slack/PagerDuty sont armées

Toutes les cases sont **non cochées** en prod. Incidents découverts par utilisateurs ou Twitter, pas par paging.

## Impact production

- Backlog outbox / DLQ non détecté → notifications perdues
- Spike error rate / latence booking invisible
- SLO breach sans escalation → SLA contractuel impossible

## Solution proposée

### Inventaire alertes (depuis checklist + runbooks)

| #   | Alerte                    | Seuil indicatif   | Source                  |
| --- | ------------------------- | ----------------- | ----------------------- |
| 1   | Worker 5xx rate           | > 0.1% / 5min     | Axiom                   |
| 2   | p99 booking latency       | > 500ms / 5min    | Axiom trace             |
| 3   | Outbox backlog depth      | > 100 rows / 5min | SQL ou métrique custom  |
| 4   | DLQ message count         | > 0               | CF Queues API ou log    |
| 5   | `/health/ready` 503       | 2 consecutive     | Checkly CK2             |
| 6   | Neon connection errors    | spike             | Axiom                   |
| 7   | Redis Upstash errors      | > 10/min          | Axiom                   |
| 8   | Queue consumer lag        | > 60s             | CF dashboard            |
| 9   | Stripe webhook failures   | > 0 / 15min       | Axiom + Sentry          |
| 10  | RGPD cron skip            | log pattern       | Axiom                   |
| 11  | Booking success rate      | < 99% / 1h        | métrique custom         |
| 12  | Cost anomaly Upstash      | > 150% baseline   | runbook cost-monitoring |
| 13  | Sentry new critical issue | any               | Sentry → Slack          |

### Implémentation

1. Créer monitors dans Axiom UI (ou API/terraform futur)
2. Lier webhook Slack `#athlya-alerts` + PagerDuty service
3. Test fire : injecter 503 sur staging, vérifier page reçue
4. Documenter dans `docs/runbooks/alerting.md` (créer si absent)

## Composants touchés

- [ ] Dashboard Axiom (monitors)
- [ ] Slack / PagerDuty integrations
- [ ] `docs/operations/v1.0.0-launch-checklist.md` — cocher items
- [ ] Optionnel : métriques custom Worker pour outbox depth

## Critères d'acceptation

- [ ] 13 alertes créées et documentées avec seuils
- [ ] Test alerte réussi sur staging (au moins 3 types)
- [ ] Checklist Phase A critère alertes = vert
- [ ] Runbook escalation lié depuis chaque alerte

## Références

- `docs/operations/v1.0.0-launch-checklist.md` L19, L18
- `docs/runbooks/outbox-ops.md`
- `docs/runbooks/cost-monitoring.md`
- Audit prod 2026-05-27 — O3

## Priorité

**P0** — ops aveugle sans alerting
