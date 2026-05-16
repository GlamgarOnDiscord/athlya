# Synthetic monitoring — Athlya

**Sprint 14 / Slice 14.5 (Epic CN.5.1 + CN.5.2 + CN.5.3 + CN.5.4)**

Catalogue des checks externes qui valident l'API + frontend
fonctionnent depuis la perspective utilisateur (pas seulement
"le process tourne").

## CN.5.1 — Checkly synthetic checks

### Provisionner Checkly

1. Créer un compte sur <https://www.checklyhq.com/> (free tier
   inclut 10 checks toutes les 60s depuis 4 régions).
2. Récupérer la clef API + l'account ID.
3. Stocker les secrets en GitHub Actions `CHECKLY_API_KEY` +
   `CHECKLY_ACCOUNT_ID` pour le futur Terraform / CLI.

### Checks recommandés

#### CK1 — Liveness `/health` (toutes 60s)

```yaml
name: Athlya API liveness
type: API
url: https://api.athlya.app/health
method: GET
locations:
  - eu-west-1   # Frankfurt
  - us-east-1   # Virginia
  - ap-southeast-1  # Singapore
expected_status: 200
expected_body_contains: '"status":"ok"'
alert_channels:
  - slack-ops
sla: 99.9%  # Sprint 14 baseline
```

#### CK2 — Readiness `/health/ready` (toutes 60s)

```yaml
name: Athlya API readiness
type: API
url: https://api.athlya.app/health/ready
method: GET
expected_status: 200
expected_body_jsonpath:
  status: ready
  checks.db.status: ok
  checks.redis.status: ok
locations:
  - eu-west-1
  - us-east-1
alert_channels:
  - slack-ops
  # Sev2 — degraded readiness page on-call.
```

#### CK3 — `/v1/classes` smoke (toutes 5min)

Authenticated check : utilise un service-account token rotaté tous
les 6 mois pour simuler un member légitime listant ses classes.

```yaml
name: Athlya API list-classes smoke
type: API
url: https://api.athlya.app/v1/classes?from=now&to=now+7d
headers:
  authorization: Bearer ${{ secrets.CHECKLY_SERVICE_TOKEN }}
expected_status: 200
expected_body_jsonpath:
  items: array
locations:
  - eu-west-1
alert_channels:
  - slack-ops
```

#### CK4 — Web app `/login` page renders (toutes 5min)

```yaml
name: Athlya Web login render
type: Browser  # Checkly Playwright check
url: https://app.athlya.app/login
expected_text:
  - 'Connexion'  # FR title
  - 'Mot de passe oublié'  # forgot-password link
locations:
  - eu-west-1
alert_channels:
  - slack-ops
```

### Alert routing — CN.5.3

Règle : 2/3 régions en fail consécutif → Slack ops alert + 5/6
régions → page on-call.

| Severity | Trigger | Action |
|---|---|---|
| Sev3 | 1 région fail | Slack #ops-athlya-alerts |
| Sev2 | 2/3 régions fail | Slack + email on-call |
| Sev1 | 3/3 régions fail OU readiness 503 sur 2+ régions | Page on-call PagerDuty |

Configuration manuelle dans l'UI Checkly. Slice future :
Terraform Checkly provider pour versionner.

## CN.5.2 — RUM (Real User Monitoring)

### Vercel Analytics — apps/web

Le frontend Next.js sur `apps/web` peut activer Vercel Analytics
gratuitement (jusqu'à 100k events/mois sur free tier) :

1. Activer dans `vercel.json` ou via le dashboard Vercel.
2. Installer `@vercel/analytics` :
   ```bash
   pnpm --filter @athlya/web add @vercel/analytics
   ```
3. Mounter dans `apps/web/src/app/layout.tsx` :
   ```tsx
   import { Analytics } from '@vercel/analytics/react';
   // …
   <body>
     {children}
     <Analytics />
   </body>
   ```

Métriques recueillies :
- LCP (Largest Contentful Paint)
- FID (First Input Delay)
- CLS (Cumulative Layout Shift)
- INP (Interaction to Next Paint) — nouveau Core Web Vital 2024
- TTFB (Time To First Byte)

Cibles :
- LCP < 2.5s p75
- FID < 100ms p75
- CLS < 0.1 p75
- INP < 200ms p75

### Sentry Performance — alternatif si pas Vercel

Pour `apps/studio` (admin app) ou si on quitte Vercel, activer
Sentry Performance avec sample rate 10% :

```ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  // …
});
```

## CN.5.4 — Cost monitoring

### Dashboard Axiom

Panneau "Cost per endpoint" dans le dashboard "Athlya — Service
Health" (cf `docs/operations/axiom-queries.md`) :

```apl
['athlya-spans']
| where _time > now(-30d)
| extend operation = tostring(['data']['name'])
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| extend cpu_ms_estimate = duration_ms * 0.7  // ~70% du wall-clock est CPU
| summarize
    requests = count(),
    cpu_ms_total = sum(cpu_ms_estimate)
    by operation
| extend cost_usd_estimate = cpu_ms_total * 0.0000125  // CF Workers paid plan
| order by cost_usd_estimate desc
| limit 20
```

### Cloudflare Analytics

Le dashboard Cloudflare expose nativement :
- Requests par jour
- CPU-ms cumulés (basis du pricing Workers)
- Bandwidth out (free) / in (paid au-delà du free tier)
- Cache hit ratio

Pas d'automation custom requise pour le moment. Slice future :
exporter via Cloudflare Analytics Engine API vers Axiom.

### Cost per studio (multi-tenant tracking)

Quand on a plusieurs studios, le cost-per-studio devient critique
pour le pricing produit. Query Axiom :

```apl
['athlya-spans']
| where _time > now(-30d)
| extend studio = tostring(['data']['attributes']['studio.id'])
| where isnotempty(studio)
| extend duration_ms = (todouble(['data']['endTimeUnixNano']) - todouble(['data']['startTimeUnixNano'])) / 1e6
| summarize
    requests = count(),
    avg_duration_ms = avg(duration_ms),
    cpu_ms_total = sum(duration_ms) * 0.7
    by studio
| extend cost_usd_estimate = cpu_ms_total * 0.0000125
| order by cost_usd_estimate desc
```

Permet de détecter les studios qui hammerent la plateforme (= bug
côté leur app, OU usage abusif qui justifie un plan plus cher).

## Provisioning checklist

| Item | Status | Owner |
|---|---|---|
| Compte Checkly free tier | ⏳ ops | DevOps |
| 4 checks CK1-CK4 | ⏳ après création compte | DevOps |
| Slack webhook ops | ⏳ | DevOps |
| Vercel Analytics activation | ⏳ après push prod web | DevOps + Eng |
| Axiom cost dashboard panel | ⏳ après data Axiom 30j | Eng |

## Tests automatisés

Pas de test unit (les services synthetic vivent en prod). Le
workflow `.github/workflows/load-test.yml` couvre la régression
perf via k6 ; le synthetic Checkly couvre la régression
disponibilité.

## Références

- Checkly docs: <https://www.checklyhq.com/docs/>
- Vercel Analytics: <https://vercel.com/analytics>
- Cloudflare Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- `docs/operations/axiom-queries.md` — queries APL
- `docs/operations/axiom-alerts.md` — alertes graduelles
