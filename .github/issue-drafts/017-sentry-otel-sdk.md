## Résumé

Observabilité partiellement **hand-rolled** pour limiter bundle Worker :

- `packages/api/src/sentry.ts` — envelope v7 minimal, pas `@sentry/cloudflare`
- `packages/api/src/middleware/otel.ts` — OTLP JSON custom, pas `@opentelemetry/sdk-*`

## Limitations actuelles

| Feature            | Hand-rolled | SDK officiel |
| ------------------ | ----------- | ------------ |
| Breadcrumbs        | ❌          | ✅           |
| Release health     | ❌          | ✅           |
| Source maps upload | ❌          | ✅           |
| OTel spec drift    | Risque      | Auto         |
| Maintenance        | Manuel      | Vendor       |

## Impact

- **Sévérité** : Medium / P2
- Debug incidents plus lent
- Envelope OTel peut diverger des backends

## Solution proposée

### Phase 1 — Mesurer bundle

```bash
wrangler deploy --dry-run --env staging 2>&1 | grep -i size
```

Seuil acceptabilité : +200KB max (doc H6 rationale).

### Phase 2 — Sentry

Si bundle OK → `@sentry/cloudflare` avec `beforeSend` PII scrub (existe déjà côté custom).

### Phase 3 — OTel

`@opentelemetry/exporter-trace-otlp-http` tree-shaken ou collector sidecar via QStash.

## Critères d'acceptation

- [ ] ADR bundle size vs features
- [ ] Si migration : parité tests `sentry.test.ts`, `otel.test.ts`
- [ ] Release tracking Sentry (`VERSION` env)
- [ ] Pas de régression p99 > 5ms middleware

## Priorité

**P2** — quand trafic prod justifie Sentry Team plan
