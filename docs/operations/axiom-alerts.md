# Axiom alerts — Athlya API

**Sprint 12 / Slice 12.12 (Epic B7.5)**

Catalogue des alertes Axiom à provisionner pour l'API Athlya. Toutes
ces alertes pointent sur un Slack channel ops + page PagerDuty pour
les Sev1.

## Pré-requis

- Slice 12.11 livrée (queries Axiom).
- Slack webhook configuré dans Axiom (Settings → Integrations).
- Channel `#ops-athlya-alerts` créé sur Slack.
- Optionnel mais recommandé : PagerDuty service `athlya-api`
  configuré pour Sev1.

## Alertes à provisionner

### A1 — Error rate > 1% (Sev2 — Slack)

```apl
['athlya-spans']
| where _time > now(-5m)
| extend status = toint(['data']['attributes']['http.status_code'])
| summarize total = count(), errors = countif(status >= 500)
| extend rate_pct = (todouble(errors) * 100.0) / todouble(total)
| where rate_pct > 1.0
```

**Trigger** : 1 row dans la fenêtre de 5 minutes.
**Cooldown** : 15 minutes (Axiom snooze).
**Channel** : `#ops-athlya-alerts`.
**Message** : `🚨 Error rate {{rate_pct}}% over the last 5min ({{errors}} 5xx out of {{total}}).`

### A2 — p95 auth.login > 200ms (Sev3 — Slack)

```apl
['athlya-spans']
| where _time > now(-5m)
| where ['data']['name'] == "auth.login"
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| summarize p95 = percentile(duration_ms, 95), count = count()
| where p95 > 200 and count > 10
```

**Trigger** : 1 row, mais filtre `count > 10` pour éviter les
faux-positifs sur faible trafic.
**Cooldown** : 30 minutes.
**Message** : `⚠️ auth.login p95={{p95}}ms (target <200ms) on {{count}} samples.`

### A3 — p99 reservations.book > 500ms (Sev2 — Slack + Page)

```apl
['athlya-spans']
| where _time > now(-5m)
| where ['data']['name'] == "reservations.book"
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| summarize p99 = percentile(duration_ms, 99), count = count()
| where p99 > 500 and count > 5
```

**Trigger** : 1 row.
**Cooldown** : 15 minutes.
**Channel** : `#ops-athlya-alerts` + page on-call.
**Message** : `🚨 reservations.book p99={{p99}}ms (target <500ms) on {{count}} samples — Redis lock contention?`

### A4 — Queue lag > 60s (Sev2 — Slack)

```apl
['athlya-spans']
| where _time > now(-5m)
| where ['data']['name'] == "drain.batch"
| extend lag_ms = todouble(['data']['attributes']['queue.lag_ms'])
| summarize p99_lag_ms = percentile(lag_ms, 99)
| where p99_lag_ms > 60000
```

**Trigger** : 1 row.
**Cooldown** : 30 minutes.
**Message** : `⚠️ Queue lag p99={{p99_lag_ms}}ms (target <60s). Drain worker stuck?`

### A5 — DLQ size > 100 (Sev2 — Slack)

```apl
['athlya-spans']
| where _time > now(-15m)
| where ['data']['name'] == "drain.dlq.stats"
| extend pending = toint(['data']['attributes']['dlq.pending'])
| summarize max_pending = max(pending)
| where max_pending > 100
```

**Trigger** : 1 row.
**Cooldown** : 1 hour.
**Message** : `📨 DLQ size={{max_pending}} (threshold 100). Investigate via /v1/admin/dlq/stats.`

### A6 — Suspicious login spike (Sev3 — Slack)

```apl
['athlya-spans']
| where _time > now(-15m)
| extend event_name = tostring(['data']['attributes']['event.type'])
| where event_name == "auth.suspicious.login.anomaly"
| summarize count = count() by bin(_time, 5m)
| where count > 5
```

**Trigger** : 1 row dans la fenêtre 5min.
**Cooldown** : 1 hour.
**Message** : `🔐 {{count}} anomalous logins in the last 5min — possible credential stuffing campaign.`

### A7 — Refresh token reuse spike (Sev1 — Slack + Page)

```apl
['athlya-spans']
| where _time > now(-5m)
| extend event_name = tostring(['data']['attributes']['event.type'])
| where event_name == "auth.suspicious.refresh.reuse"
| summarize count = count()
| where count > 1
```

**Trigger** : 1 row. Threshold bas (>1) parce qu'un refresh-token
reuse est un signal très fort de token theft.
**Cooldown** : 5 minutes.
**Channel** : `#ops-athlya-alerts` + page on-call.
**Message** : `🚨 SECURITY: {{count}} refresh-token reuse(s) in 5min. Investigate via audit_log table.`

### A8 — Concurrency limit storm (Sev3 — Slack)

```apl
['athlya-spans']
| where _time > now(-15m)
| extend status = toint(['data']['attributes']['http.status_code'])
| extend code = tostring(['data']['attributes']['error.code'])
| where status == 429 and code == "concurrency_limit_exceeded"
| summarize count = count()
| where count > 20
```

**Trigger** : 1 row.
**Cooldown** : 1 hour.
**Message** : `⚠️ {{count}} concurrency_limit_exceeded over 15min. Investigate which user(s) are saturating.`

### A9 — Sentry DSN missing (Sev3 — Slack, boot-time)

Cette alerte se base sur les logs (pas les spans) — elle détecte le
warning structuré émis au boot par `assertSentryDsnIsEu`.

```apl
['athlya-logs']
| where _time > now(-30m)
| where msg == "CORS_ORIGIN missing in non-dev env; rejecting all cross-origin requests"
   or msg == "SENTRY_DSN secret not in EU region"
| summarize count = count() by msg
| where count > 0
```

**Trigger** : 1 row.
**Cooldown** : 24 hours (= une fois par déploiement maximum).
**Message** : `🔧 Configuration error: {{msg}} — check wrangler secrets.`

### A10 — HIBP unavailable rate (Sev3 — Slack)

Le fail-CLOSED policy de Sprint 3 SP3.2 rejette une registration sur
`hibp_unavailable`. Une vague de cet error indique que HIBP est down
et que les utilisateurs ne peuvent pas s'inscrire.

```apl
['athlya-spans']
| where _time > now(-15m)
| extend code = tostring(['data']['attributes']['error.code'])
| where code == "hibp_unavailable"
| summarize count = count()
| where count > 5
```

**Trigger** : 1 row.
**Cooldown** : 30 minutes.
**Message** : `⚠️ HIBP unavailable rejecting {{count}} registrations in 15min. Possible HIBP outage; consider toggling soft-fail flag (slice future).`

## Provisioning runbook

Manuel pour le moment (slice future = Terraform Axiom provider) :

1. Pour chaque alerte ci-dessus :
   - Ouvrir Axiom UI → Monitors → Create Alert
   - Coller la query APL
   - Configurer le trigger (exemple : `Result count > 0`)
   - Configurer le notification channel (Slack webhook ou PagerDuty)
   - Set le cooldown / snooze period
   - Set le severity tag

2. Tester chaque alerte une fois en triggering manuellement (par
   exemple en faisant 6 logins échoués pour A6).

3. Documenter le `monitor_id` Axiom dans ce fichier en commentaire
   suivant chaque alerte une fois provisionné.

## Sev levels

- **Sev1** : page on-call immédiat. Production-down ou
  security-critical (A7 refresh reuse spike).
- **Sev2** : Slack alert + page on-call si pas resolution en 30min.
  Production degraded (A1 error rate, A3 booking p99, A4 queue lag,
  A5 DLQ).
- **Sev3** : Slack alert only. Investigation needed mais pas
  d'impact user immédiat (A2, A6, A8, A9, A10).

## Tests

Pas de test automatisé pour les alertes Axiom (vivent uniquement en
prod). Test manuel via injection de signal contrôlé :

```bash
# Test A1 (error rate) — déclencher 5 erreurs 5xx en 5min en
# pointant un endpoint vers un binding cassé.
for i in {1..5}; do
  curl -X GET https://api.athlya.app/v1/classes \
    -H "Authorization: Bearer <BAD_TOKEN>" \
    --header "x-test-induce-5xx: yes"
done

# Test A6 (suspicious login) — login depuis 6 IPs différentes
# rapidement.
# (utiliser un VPN qui rotate les pays).
```

## Références

- `docs/operations/axiom-queries.md` — queries underlying chaque
  alerte
- Slice 12.9 (B7.3) — span naming
- Slice 12.10 (B7.2) — breadcrumbs
- Slice 12.11 (B7.4) — queries

## Burn rate alerts (Sprint 14 / Slice 14.6 — CN.1.2)

Pattern Google SRE Workbook : alerter sur le rythme de
consommation du SLO budget plutôt que sur le budget restant.
Détecte une régression bien plus tôt qu'un seuil absolu.

### A11 — S1 (booking p99) burn rate > 2x (Sev2 + page)

Query dans `docs/operations/axiom-queries.md#s1-burn-rate-booking-p99`.

**Trigger** : 1 row dans la fenêtre 1h.
**Cooldown** : 1 hour.
**Channel** : `#ops-athlya-alerts` + page on-call.
**Message** : `🚨 Booking p99 burning {{burn_rate}}x faster than budget allows. {{bad}} slow requests of {{total}} in 1h.`

**Action** : check Axiom dashboard, identify if regression is :

- Code-related (recent deploy) → rollback via `wrangler rollback`
- Dependency-related (Neon / Upstash slow) → check Cloudflare
  status + Neon status

### A12 — S3 (error rate) burn rate > 2x (Sev2 + page)

Query dans `docs/operations/axiom-queries.md#s3-burn-rate-error-rate`.

**Trigger** : 1 row dans la fenêtre 1h.
**Cooldown** : 30min (plus aggressive que A11 — un error rate
spike est typiquement code-side et nécessite reaction rapide).
**Channel** : `#ops-athlya-alerts` + page on-call.
**Message** : `🚨 5xx burn rate {{burn_rate}}x. {{errors}} errors of {{total}} in 1h.`

### A13 — S4 (queue lag) burn rate > 2x (Sev3)

Pareil que A4 mais sur le burn rate plutôt que la valeur absolue.
Sev3 parce qu'un queue lag temporaire ne pénalise que la
latence des notifications, pas le user-visible flow.

**Cooldown** : 2h.
**Channel** : `#ops-athlya-alerts` (Slack only).
