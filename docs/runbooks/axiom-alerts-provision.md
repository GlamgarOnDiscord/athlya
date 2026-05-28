# Provisioning — 13 alertes Axiom (issue #120)

**Owner:** SRE / on-call  
**Durée estimée:** ~3 h (Day 2 checklist)  
**Définitions APL:** [`docs/operations/axiom-alerts.md`](../operations/axiom-alerts.md) (A1–A13)

---

## Prérequis

- [ ] Dataset Axiom `athlya-spans` + `athlya-logs` reçoivent OTel depuis staging/prod (vérifier ingest dernière heure).
- [ ] Slack app → webhook → channel `#ops-athlya-alerts`.
- [ ] PagerDuty service `athlya-api` (Sev1/Sev2 page).
- [ ] Checkly CK2 couvre `/health/ready` 503 (hors Axiom — voir [`synthetic-monitoring.md`](../operations/synthetic-monitoring.md)).

---

## Inventaire des 13 monitors

| ID | Nom | Sev | Route | Query |
|----|-----|-----|-------|-------|
| A1 | Error rate 5xx > 1% / 5m | 2 | Slack | `axiom-alerts.md` § A1 |
| A2 | auth.login p95 > 200ms | 3 | Slack | § A2 |
| A3 | reservations.book p99 > 500ms | 2 | Slack + PD | § A3 |
| A4 | Queue lag p99 > 60s | 2 | Slack | § A4 |
| A5 | DLQ pending > 100 | 2 | Slack | § A5 |
| A6 | Suspicious login spike | 3 | Slack | § A6 |
| A7 | Refresh token reuse | 1 | Slack + PD | § A7 |
| A8 | Concurrency 429 storm | 3 | Slack | § A8 |
| A9 | Boot config error (CORS/Sentry EU) | 3 | Slack | § A9 |
| A10 | HIBP unavailable registrations | 3 | Slack | § A10 |
| A11 | S1 booking burn rate > 2x | 2 | Slack + PD | § A11 |
| A12 | S3 error burn rate > 2x | 2 | Slack + PD | § A12 |
| A13 | S4 queue lag burn rate > 2x | 3 | Slack | § A13 |

**Mapping checklist launch (9 incident + 4 burn):**

| Item checklist | Monitor |
|----------------|---------|
| DLQ non-vide | A5 |
| Login anomaly spike | A6 |
| HIBP service down | A10 |
| Error rate / 5xx | A1 |
| Booking p99 SLO | A3, A11 |
| Queue / notification lag | A4, A13 |
| Refresh reuse (security) | A7 |
| Config boot errors | A9 |
| Concurrency storm | A8 |
| Burn availability (proxy error) | A12 |
| Burn latency login | A2 |

Items checklist **non-Axiom** (autre outil) : JWKS rotation expirée → runbook [`rotate-jwt.md`](./rotate-jwt.md) + alerte calendrier ; Stripe webhook → Sentry + audit `billing.stripe.signature_failed` ; RLS violation → audit `rls.violation` + future log alert ; RGPD cron skip → log `rgpd_maintenance_cycle_skipped` (alerte logs Phase B).

---

## Procédure par monitor (Axiom UI)

Pour **chaque** A1–A13 :

1. **Monitors → New monitor → Custom query**
2. Coller la query APL depuis `axiom-alerts.md`
3. **Trigger:** `Number of results` > 0 (ou équivalent)
4. **Evaluation window:** voir cooldown dans la fiche alerte
5. **Notification:** Slack `#ops-athlya-alerts` ; ajouter PagerDuty si Sev1/Sev2 + page indiqué
6. **Snooze / cooldown:** valeur documentée dans `axiom-alerts.md`
7. Noter le **Monitor ID** Axiom dans le tableau ci-dessous (commit ops ou ticket)

### Table de suivi provisioning

| ID | Monitor ID Axiom | Provisionné | Test fire |
|----|------------------|-------------|-----------|
| A1 | | [ ] | [ ] |
| A2 | | [ ] | [ ] |
| A3 | | [ ] | [ ] |
| A4 | | [ ] | [ ] |
| A5 | | [ ] | [ ] |
| A6 | | [ ] | [ ] |
| A7 | | [ ] | [ ] |
| A8 | | [ ] | [ ] |
| A9 | | [ ] | [ ] |
| A10 | | [ ] | [ ] |
| A11 | | [ ] | [ ] |
| A12 | | [ ] | [ ] |
| A13 | | [ ] | [ ] |

---

## Tests obligatoires (min. 3 avant go-live)

### T1 — Readiness / infra (Checkly, pas Axiom)

Sur staging, provoquer 2× `/health/ready` 503 (secret DB_URL invalide temporaire) → alerte CK2.

### T2 — Error rate (A1)

Staging : générer >1% 5xx sur 5 min (endpoint test ou binding cassé volontairement) → Slack A1.

### T3 — DLQ / outbox (A5 ou snapshot)

Staging : publier message invalide sur queue → DLQ > 0 → A5 ou inspection [`event-bus.md`](./event-bus.md).

Documenter captures Slack + Monitor ID dans le ticket #120 ou wiki ops.

---

## Validation finale

```powershell
node scripts/verify-axiom-alerts-checklist.mjs
```

Tous les `[ ]` cochés en prod + staging ; aucun monitor en état `Firing` non expliqué pendant **7 jours** (Phase A checklist).

---

## Escalade

| Sev | Action |
|-----|--------|
| 1 | Page on-call immédiat (A7) |
| 2 | Slack + page si pas ACK 30 min (A1, A3, A4, A5, A11, A12) |
| 3 | Slack only — investigation jour ouvré |

Runbooks liés : [`outbox-ops.md`](./outbox-ops.md), [`event-bus.md`](./event-bus.md), [`cost-monitoring.md`](./cost-monitoring.md), [`canary-deploy.md`](./canary-deploy.md).

---

## Références

- Issue #120, audit O3
- [`docs/operations/v1.0.0-launch-checklist.md`](../operations/v1.0.0-launch-checklist.md) Day 2
- [`docs/operations/axiom-queries.md`](../operations/axiom-queries.md)
