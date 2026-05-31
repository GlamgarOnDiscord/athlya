# Axiom queries — Athlya API metrics

**Sprint 12 / Slice 12.11 (Epic B7.4)**

Catalogue des queries APL (Axiom Processing Language) qui produisent
les métriques business p50/p95/p99 + error rate + RPS + queue lag à
partir des spans OTel exportés par le gateway.

## Pré-requis

- Workers configurés avec `OTEL_EXPORTER_OTLP_ENDPOINT` pointant sur
  Axiom (`https://api.axiom.co/v1/traces` + auth header).
- Dataset Axiom `athlya-spans` qui reçoit les envelopes OTLP.
- Slice 12.9 (B7.3) livrée : spans nommés `<verb>.<domain>` (ex
  `auth.login`, `reservations.book`).

## Queries

### Latency p50 / p95 / p99 par opération

```apl
['athlya-spans']
| where _time > now(-1h)
| extend operation = tostring(['data']['name'])
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| where duration_ms > 0
| summarize
    p50 = percentile(duration_ms, 50),
    p95 = percentile(duration_ms, 95),
    p99 = percentile(duration_ms, 99),
    count = count()
    by operation
| order by p99 desc
```

**Cibles SLO** :

- `auth.login` : p95 < 200ms
- `reservations.book` : p99 < 500ms
- `classes.list` : p95 < 100ms (avec ETag → 304 souvent)

### Error rate par status code

```apl
['athlya-spans']
| where _time > now(-1h)
| extend status = toint(['data']['attributes']['http.status_code'])
| extend operation = tostring(['data']['name'])
| summarize
    total = count(),
    errors_5xx = countif(status >= 500),
    errors_4xx = countif(status >= 400 and status < 500)
    by operation
| extend error_rate_pct = (todouble(errors_5xx) * 100.0) / todouble(total)
| order by error_rate_pct desc
```

**Cible SLO** : `error_rate_pct < 0.1%` global.

### RPS (requests per second) par opération

```apl
['athlya-spans']
| where _time > now(-15m)
| extend operation = tostring(['data']['name'])
| summarize count = count() by bin(_time, 1s), operation
| extend rps = count
| project _time, operation, rps
```

### Latency timeseries par opération (chart-friendly)

```apl
['athlya-spans']
| where _time > now(-6h)
| extend operation = tostring(['data']['name'])
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| summarize p95 = percentile(duration_ms, 95) by bin(_time, 1m), operation
| order by _time asc
```

### Erreurs par tenant (studio)

Utilise les attributes `studio.id` et `user.id` stampés
automatiquement par le middleware OTel (`packages/api/src/middleware/otel.ts`).

```apl
['athlya-spans']
| where _time > now(-1h)
| extend status = toint(['data']['attributes']['http.status_code'])
| extend studio = tostring(['data']['attributes']['studio.id'])
| where status >= 500
| where isnotempty(studio)
| summarize errors = count() by studio, bin(_time, 5m)
| order by errors desc
```

### Top N opérations les plus lentes

```apl
['athlya-spans']
| where _time > now(-1h)
| extend operation = tostring(['data']['name'])
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| where duration_ms > 0
| summarize p99 = percentile(duration_ms, 99), avg_ms = avg(duration_ms) by operation
| order by p99 desc
| limit 10
```

### Breadcrumb lookup par traceId

Pour reconstituer le chemin d'une session ayant abouti à un 5xx, on
filtre les events stampés par `addBreadcrumb()` (Slice 12.10).

```apl
['athlya-spans']
| where _time > now(-1h)
| extend trace_id = tostring(['data']['traceId'])
| where trace_id == "<TRACE_ID_FROM_SENTRY>"
| mv-expand events = ['data']['events']
| extend event_name = tostring(events['name'])
| where event_name startswith "breadcrumb."
| project _time, event_name, events['attributes']
| order by _time asc
```

### Queue lag (drain worker)

Le drain worker stamp un span `drain.batch` à chaque tick — la
duration mesure le lag entre `outbox.created_at` du plus ancien
event et `now()` au moment du drain.

```apl
['athlya-spans']
| where _time > now(-1h)
| where ['data']['name'] == "drain.batch"
| extend lag_ms = todouble(['data']['attributes']['queue.lag_ms'])
| summarize p99_lag_ms = percentile(lag_ms, 99) by bin(_time, 1m)
| order by _time asc
```

**Cible SLO** : queue lag p99 < 60s.

### Unknown queue event types (issue #132)

Structured log `queue.unknown_event_type` emitted by `reject-unknown-queue-event.ts`.

```apl
['athlya-logs']
| where _time > now(-1h)
| where ['message'] == "queue.unknown_event_type"
| summarize count = count() by eventType = tostring(['eventType']), queue = tostring(['queue'])
| order by count desc
```

### Outbox backlog & drain overlap (issue #134)

`drain-scheduled.ts` émet `outbox.backlog` à chaque cron tick et `outbox.drain_overlap_risk` quand un cycle dépasse 45s.

```apl
['athlya-logs']
| where _time > now(-6h)
| where ['message'] == "outbox.backlog"
| summarize pending = max(toint(['pending'])), ageMs = max(tolong(['ageMs'])) by bin(_time, 1m)
| order by _time asc
```

```apl
['athlya-logs']
| where _time > now(-6h)
| where ['message'] == "outbox.drain_overlap_risk"
| summarize slowCycles = count(), maxDurationMs = max(tolong(['durationMs'])) by bin(_time, 5m)
| order by _time asc
```

### Capacity drift Redis↔PG (issue #135)

Le cron `capacity-reconcile-runner.ts` émet `capacity.drift` par classe divergente, et `capacity reconcile: sweep complete` en fin de passe.

```apl
['athlya-logs']
| where _time > now(-6h)
| where ['message'] == "capacity.drift"
| summarize drifts = count(), maxAbsDrift = max(abs(toint(['drift']))) by bin(_time, 5m), direction = tostring(['direction'])
| order by _time asc
```

```apl
['athlya-logs']
| where _time > now(-6h)
| where ['message'] == "capacity reconcile: sweep complete"
| project _time, checked = toint(['checked']), drifted = toint(['drifted']), healed = toint(['healed']), healFailures = toint(['healFailures'])
| order by _time desc
```

### CSP violations (issue #136)

`POST /v1/csp-report` (`routes/csp-report.ts`) émet `csp.violation` par violation. Filtrer le bruit des extensions navigateur.

```apl
['athlya-logs']
| where _time > now(-24h)
| where ['message'] == "csp.violation"
| where tostring(['blockedUri']) !startswith "chrome-extension:" and tostring(['blockedUri']) !startswith "moz-extension:"
| summarize violations = count() by directive = tostring(['effectiveDirective']), disposition = tostring(['disposition'])
| order by violations desc
```

### Concurrency limit hits

Le `concurrency-limit.ts` middleware stamp un span event sur 429.
Détection des users qui touchent le cap.

```apl
['athlya-spans']
| where _time > now(-24h)
| extend status = toint(['data']['attributes']['http.status_code'])
| extend code = tostring(['data']['attributes']['error.code'])
| where status == 429 and code == "concurrency_limit_exceeded"
| extend user = tostring(['data']['attributes']['user.id'])
| summarize hits = count() by user
| order by hits desc
| limit 20
```

## Dashboards Axiom

### Dashboard "Athlya — Service Health"

Panneaux recommandés (à créer manuellement dans l'UI Axiom) :

1. **p50/p95/p99 latency** (timeseries) — query `Latency timeseries
par opération`, group by `operation`, 6h window.
2. **Error rate** (single value) — query `Error rate par status
code`, agrégé all operations, 1h.
3. **RPS** (timeseries) — query `RPS`, group by `operation`, 15m
   window.
4. **Top 10 slowest operations** (table) — query `Top N opérations`.
5. **Errors by tenant** (table avec drill-down) — query `Erreurs par
tenant`.
6. **Queue lag p99** (timeseries) — query `Queue lag`, 1h window.

### Export JSON

L'UI Axiom permet d'exporter le dashboard en JSON. Une fois créé,
exporter et committer dans `docs/operations/axiom-dashboard.json`
pour le rendre versionnable. Slice future à automatiser via
Terraform Axiom provider.

## Alertes (Slice 12.12 = B7.5)

Voir `docs/operations/axiom-alerts.md`.

## Tests automatisés

Pas de test unit pour les queries (par construction — elles vivent
en prod). Le test integration `gateway.integration.test.ts` valide
que les spans sont bien envoyés à `OTEL_EXPORTER_OTLP_ENDPOINT`,
contenant les attributs requis (`http.status_code`, `studio.id`,
`user.id`, etc.). Si ces attributs disparaissent, les queries
ci-dessus retourneraient `null` — ce serait un signal de
régression côté instrumentation.

## Références

- `packages/api/src/middleware/otel.ts` — span builder
- `packages/api/src/routes/helpers.ts` — `traceOperation` +
  `addBreadcrumb`
- Requirement 30.4 — observabilité
- Axiom APL docs: <https://axiom.co/docs/apl/introduction>

## SLO computation queries (Sprint 14 / Slice 14.6 — CN.1.1+CN.1.3)

Les queries ci-dessous calculent le ratio "good" requests sur les
fenêtres SLO documentées dans `docs/operations/slos.md`. Stockées
sous forme de saved queries Axiom + dashboardées dans le panneau
"SLO compliance".

### S1 — Booking p99 < 500ms (rolling 30d)

```apl
['athlya-spans']
| where _time > now(-30d)
| where ['data']['name'] == "reservations.book"
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| where duration_ms > 0
| extend within_slo = duration_ms < 500
| summarize
    total = count(),
    good = countif(within_slo)
| extend slo_compliance_pct = (todouble(good) * 100.0) / todouble(total)
| extend error_budget_consumed_pct = 100.0 - slo_compliance_pct
```

**Cible** : `slo_compliance_pct > 99.9`. Quand le résultat tombe
sous 99.9, on a déjà brûlé tout le budget mensuel.

### S2 — Login p95 < 200ms (rolling 30d)

```apl
['athlya-spans']
| where _time > now(-30d)
| where ['data']['name'] == "auth.login"
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| where duration_ms > 0
| extend within_slo = duration_ms < 200
| summarize
    total = count(),
    good = countif(within_slo)
| extend slo_compliance_pct = (todouble(good) * 100.0) / todouble(total)
```

**Cible** : > 95%.

### S3 — Global error rate < 0.1% (rolling 30d)

```apl
['athlya-spans']
| where _time > now(-30d)
| extend status = toint(['data']['attributes']['http.status_code'])
| summarize
    total = count(),
    errors_5xx = countif(status >= 500)
| extend error_rate_pct = (todouble(errors_5xx) * 100.0) / todouble(total)
| extend slo_compliance_pct = 100.0 - error_rate_pct
```

**Cible** : `slo_compliance_pct > 99.9`.

### S4 — Queue lag p99 < 60s (rolling 30d)

```apl
['athlya-spans']
| where _time > now(-30d)
| where ['data']['name'] == "drain.batch"
| extend lag_ms = todouble(['data']['attributes']['queue.lag_ms'])
| where lag_ms > 0
| extend within_slo = lag_ms < 60000
| summarize
    total = count(),
    good = countif(within_slo)
| extend slo_compliance_pct = (todouble(good) * 100.0) / todouble(total)
```

**Cible** : > 99.9%.

## Burn rate alerts (CN.1.2)

Plutôt que d'attendre que le budget soit épuisé pour alerter, on
mesure le **rythme** auquel il brûle. À 2x burn rate sur 1h = on
brûle 2x plus vite que la budget allow → on aurait épuisé le
budget mensuel en 15 jours au lieu de 30.

### S1 burn rate (booking p99)

```apl
['athlya-spans']
| where _time > now(-1h)
| where ['data']['name'] == "reservations.book"
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| where duration_ms > 0
| extend within_slo = duration_ms < 500
| summarize
    total = count(),
    bad = countif(not(within_slo))
| extend bad_rate_pct = (todouble(bad) * 100.0) / todouble(total)
| extend burn_rate = bad_rate_pct / 0.1   // 0.1% = SLO budget rate
| where burn_rate > 2.0
```

**Trigger** : 1 row → Sev2 + page on-call.

### S3 burn rate (error rate)

```apl
['athlya-spans']
| where _time > now(-1h)
| extend status = toint(['data']['attributes']['http.status_code'])
| summarize
    total = count(),
    errors = countif(status >= 500)
| extend error_rate_pct = (todouble(errors) * 100.0) / todouble(total)
| extend burn_rate = error_rate_pct / 0.1
| where burn_rate > 2.0
```

**Trigger** : 1 row → Sev2 + page on-call.
