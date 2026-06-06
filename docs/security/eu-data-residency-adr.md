# ADR — EU data residency (issue #66)

**Statut** : accepté (MVP)  
**Date** : 2026-05-27  
**Décideurs** : CTO / DPO (validation DPIA §8)

## Contexte

Athlya promet une résidence des **données au repos** en UE (Neon `aws-eu-central-1`, Upstash `eu-west-1`, Sentry EU, R2/Queues dans le compte CF EU). Le **compute** Cloudflare Workers peut toutefois s'exécuter sur des PoP proches du client ou du backend (Smart Placement), sans garantie de pin région `region_exclusive_eu` (réservé Workers Enterprise).

## Décision

**Go** sur Smart Placement + dépendances EU-pinnées pour le MVP. **No-go** sur `region_exclusive_eu` tant que le plan Workers Enterprise n'est pas souscrit.

| Couche                | Mécanisme                                       | Résidence effective                     |
| --------------------- | ----------------------------------------------- | --------------------------------------- |
| Postgres              | Neon EU + Hyperdrive (config EU)                | UE                                      |
| Redis                 | Upstash EU                                      | UE                                      |
| Object / queues       | R2 + Queues compte EU                           | UE                                      |
| Observabilité         | Sentry `*.de.sentry.io`, Axiom EU dataset       | UE (configurer DPA)                     |
| Compute Workers       | Smart Placement (`wrangler.toml` `[placement]`) | **Optimisation latence, pas pin légal** |
| Edge request metadata | JWT, traceId, logs structurés                   | Peut transiter PoP hors UE              |

## Conséquences

- Le README ne doit plus affirmer « exclusivement en UE » pour le **traitement edge** — formulation « données au repos en UE ; compute edge Cloudflare (Smart Placement) ».
- DPIA §8 (transferts) complété dans `docs/security/dpia-template.md`.
- Réévaluation si : passage Enterprise (`compatibility_flags = ["region_exclusive_eu"]`), ou exigence client/DPO de pin compute strict.

## Alternatives rejetées

1. **Redis-backed circuit breaker global** — hors scope résidence ; voir issue #73 / ADR H3 dans `circuit-breaker.ts`.
2. **API gateway EU-only (Fly.io, etc.)** — éjection path documentée ; coût ops + perte intégration CF Queues/DO.
3. **Désactiver Smart Placement** — latence p99 réservation dégradée sans gain légal clair tant que les données au repos restent EU.

## Actions ops

- [ ] DPA Cloudflare : confirmer Data Localization Addendum / clauses transfert edge.
- [ ] Axiom : dataset EU + DPA (logs OTLP `OTEL_EXPORTER_OTLP_*`).
- [ ] Stripe Atlas EU / Resend EU : valider contrats (DPIA §2).
- [ ] Enterprise : activer `region_exclusive_eu` staging + prod dans `wrangler.toml` quand budget OK.

## Références

- `packages/api/wrangler.toml` — commentaire « EU-only placement »
- Issue #66, finding S5-012
