# Observability hand-rolled — ADR (issue #76)

**Décision** : conserver exporters custom en v0.1 ; réévaluer après mesure bundle post-#83 sampling.

## Contexte

- `packages/api/src/sentry.ts` — envelope Sentry v7 minimal
- `packages/api/src/middleware/otel.ts` — OTLP/HTTP JSON sans `@opentelemetry/sdk-*`

Raison initiale (H6) : SDK OTel > 200 KB Worker compilé ; isolates Workers incompatibles avec singleton SDK global.

## Trade-offs

|                              | Hand-rolled                            | `@sentry/cloudflare` + OTel SDK |
| ---------------------------- | -------------------------------------- | ------------------------------- |
| Bundle                       | ~faible                                | +200 KB estimé                  |
| Breadcrumbs / release health | limité                                 | complet                         |
| Spec drift OTLP              | risque mitigé par tests `otel.test.ts` | vendor                          |
| PII scrub                    | implémenté custom                      | `beforeSend`                    |

## Prochaines étapes

1. `wrangler deploy --dry-run --env staging` → noter taille compilée
2. Si < +150 KB : spike `@sentry/cloudflare` avec parité `sentry.test.ts`
3. OTel : garder hand-rolled tant que sampling (#83) suffit au budget Axiom

## Références

- `docs/operations/axiom-alerts.md`
- Issue #76
