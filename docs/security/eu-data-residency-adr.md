# ADR — EU data residency (issues #66, #327)

**Statut** : accepté (v1.0 — EU-preferred, not EU-guaranteed)  
**Date** : 2026-05-27 · Mis à jour : 2026-07-04  
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

## Déclaration de conformité (issue #327)

Le traitement des données personnelles Athlya repose sur le principe suivant :

> **Les données au repos sont hébergées exclusivement dans des datacenters UE.
> Le compute Workers Cloudflare est EU-optimisé (Smart Placement), pas EU-garanti.
> Aucune affirmation publique ne peut présenter l'exécution edge comme EU-exclusive
> tant que Workers Enterprise `region_exclusive_eu` n'est pas activé.**

Les communications marketing et la documentation technique doivent utiliser la formulation :
« Données stockées en UE — traitement edge Cloudflare (EU-optimisé, Smart Placement) ».

## DPA et transferts hors UE — état

| Sous-traitant | Base légale transfert          | Région données                         | Statut DPA                               |
| ------------- | ------------------------------ | -------------------------------------- | ---------------------------------------- |
| Cloudflare    | SCCs (Data Localization Suite) | PoP global (compute) / EU (R2, Queues) | À confirmer : Data Localization Addendum |
| Neon          | SCCs AWS EU                    | `aws-eu-central-1`                     | ✅ AWS DPA EU couvre Neon                |
| Upstash       | SCCs                           | `eu-west-1`                            | À confirmer : DPA Upstash                |
| Sentry        | SCCs                           | `*.de.sentry.io`                       | ✅ Sentry EU — endpoint DE               |
| Axiom         | SCCs                           | EU dataset                             | À confirmer : DPA Axiom EU               |
| Resend        | SCCs                           | EU infra                               | À confirmer : DPA Resend                 |
| Stripe        | SCCs                           | EU (Stripe Atlas)                      | À confirmer : Stripe DPA Art. 28         |

Les DPA « À confirmer » doivent être signés avant toute mise en production RGPD-déclarée.
Documenter les signatures dans `docs/security/dpia-template.md`.

## Actions ops

- [ ] DPA Cloudflare : signer le Data Localization Addendum (Data Localization Suite).
- [ ] Axiom : valider dataset EU + DPA (logs OTLP `OTEL_EXPORTER_OTLP_*`).
- [ ] Upstash : valider DPA EU.
- [ ] Stripe : valider DPA Art. 28 et clauses SCCs.
- [ ] Resend : valider DPA EU.
- [ ] Enterprise (future) : activer `region_exclusive_eu` staging + prod dans `wrangler.toml` après souscription Workers Enterprise.

## Références

- `packages/api/wrangler.toml` — commentaire « EU-only placement »
- Issue #66, issue #327, finding S5-012
- `docs/security/dpia-template.md` — DPIA §2, §8
