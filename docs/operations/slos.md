# SLOs — Athlya API

**Sprint 14 / Slice 14.1 (Epic CN.1.4)**

Service Level Objectives engagés pour l'API Athlya. Tous les SLOs
sont mesurés sur 30-day rolling windows et reportés sur le
dashboard Axiom "Athlya — Service Health" (cf
`docs/operations/axiom-queries.md`).

## SLOs primaires

### S1 — Booking p99 latency

**Endpoint** : `POST /v1/reservations` (span `reservations.book`)

**Objectif** : `p99 < 500ms` sur la fenêtre 30 jours.

**Justification** : c'est l'algorithme le plus contention-critical
du système (Redis DECR + Neon `FOR UPDATE` + outbox transactional).
Au-delà de 500ms, l'utilisateur perçoit le formulaire comme cassé.

**Error budget** : 0.1% de requêtes peuvent dépasser 500ms sur 30
jours.

**Alerting** : alerte A3 (`docs/operations/axiom-alerts.md` — Sev2

- page on-call).

### S2 — Login p95 latency

**Endpoint** : `POST /v1/auth/login` (span `auth.login`)

**Objectif** : `p95 < 200ms` sur la fenêtre 30 jours.

**Justification** : login est sur le chemin critique de chaque
session. bcrypt verify est dimensionné pour ~80ms ; les 120ms
restants couvrent JWKS + Postgres + HIBP cache miss + retry.

**Error budget** : 5% des logins peuvent dépasser 200ms.

**Alerting** : alerte A2 (Sev3, Slack only).

### S3 — Global error rate

**Scope** : tous les endpoints `/v1/*`.

**Objectif** : `error_rate_5xx < 0.1%` sur la fenêtre 30 jours.

**Justification** : un 5xx est par définition un bug ou une
indisponibilité de dépendance. Au-dessus de 0.1% l'app devient
inutilisable. Stripe se cible à 0.01% mais nous partons plus
conservateur.

**Error budget** : 0.1% des requêtes peuvent renvoyer 5xx.

**Alerting** : alerte A1 (Sev2, fenêtre 5min).

### S4 — Queue lag p99

**Métrique** : délai entre `outbox.created_at` du plus ancien event
et `now()` au moment du drain (span `drain.batch.queue.lag_ms`).

**Objectif** : `p99 < 60s` sur la fenêtre 30 jours.

**Justification** : les events de notification (booking confirmé,
rappel cours) doivent atteindre l'utilisateur dans la minute.
Au-delà, l'expérience produit se dégrade.

**Error budget** : 0.1% des batches peuvent avoir un lag > 60s.

**Alerting** : alerte A4 (Sev2, fenêtre 5min).

## SLOs secondaires (informatifs, sans error budget)

### S5 — Class listing p95

**Endpoint** : `GET /v1/classes` (span `classes.list`)
**Cible informative** : `p95 < 100ms` (avec ETag/304 souvent).

### S6 — DLQ size

**Métrique** : `drain.dlq.stats.dlq.pending`
**Cible informative** : `< 100 messages` en steady state.

### S7 — Booking idempotency hit rate

**Métrique** : `% des POST /v1/reservations qui hit le cache idempotency`
**Cible informative** : `< 5%` (au-dessus = clients qui spamment retry).

## Procédure de mise à jour

Modifier ce document **avant** de toucher les seuils dans Axiom :

- Discussion équipe + product validation
- PR review obligatoire (les SLOs sont des engagements
  produit/ingénierie)
- Mise à jour synchronisée des seuils dans
  `docs/operations/axiom-alerts.md`

## Burn rate alerts

Quand l'error budget brûle plus vite que prévu, on est sur le
chemin d'un SLO miss à la fin de la fenêtre 30j. Axiom alerte
quand le burn rate dépasse 2x sur une fenêtre 1h (= au rythme
actuel, on aurait épuisé le budget en 15 jours au lieu de 30).

Voir `docs/operations/axiom-alerts.md#burn-rate-alerts` pour les
queries APL associées (Slice 14.6).

## Histoire des SLOs

| Version | Date       | Auteur                 | Changement       |
| ------- | ---------- | ---------------------- | ---------------- |
| 1.0     | 2026-05-15 | Sprint 14 / Slice 14.1 | Document initial |

## Références

- `docs/operations/axiom-queries.md` — queries APL des SLOs
- `docs/operations/axiom-alerts.md` — alertes et severity mapping
- `packages/api/src/middleware/otel.ts` — instrumentation spans
- Requirement 30.1 — observabilité OTel
- Google SRE Workbook — Implementing SLOs
