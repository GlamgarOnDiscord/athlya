# ADR — Hébergement du web Next.js (issue #139 / audit A6)

**Statut** : accepté — décision **OpenNext → Cloudflare Workers**
**Date** : 2026-05-31
**Décideurs** : CTO (infra) — réévaluation si blocage maturité OpenNext
**Finding** : audit prod 2026-05-27 A6 (Medium) — déploiements non atomiques, CORS/cookies cross-site, surface CSRF élargie

## Contexte

- API : Hono sur **Cloudflare Workers** (`packages/api`, wrangler).
- Web : Next.js 16 (`apps/web`) avec un TODO `@opennextjs/cloudflare` dans `next.config.ts` ; hébergement cible non figé (Vercel implicite).
- Auth web : pattern **BFF** — les routes Next `/api/auth/*` (`apps/web/src/app/api/auth/*`) détiennent un cookie refresh **host-only** (`athlya.refresh`, `Path=/api/auth`, `SameSite=Lax`, `HttpOnly`, **sans `Domain`** — cf. `apps/web/src/lib/auth/cookies.ts`, finding S4-006). L'access token vit **en mémoire** (`token-store.ts`) et part en `Bearer` vers l'API.
- API CORS : `CORS_ORIGIN` + `credentials: true` (`worker.ts`) — un web sur un **autre domaine** (Vercel `*.vercel.app` ou domaine séparé) classe les requêtes web→API comme **cross-site**, élargit la surface CORS/CSRF et complique le pinning EU.
- ADR EU residency (`eu-data-residency-adr.md`) : dépendances **EU-pinnées sur Cloudflare**. Vercel ajouterait un vendor (et une région compute) hors du périmètre CF EU déjà cadré.

## Décision

**Déployer le web via `@opennextjs/cloudflare` sur Cloudflare Workers**, même compte/zone que l'API.

### Comparatif

| Option                               | Pour                                                                                                                                                                                                                              | Contre                                                                                                                          | Verdict |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **OpenNext CF** (retenu)             | Même vendor (1 pipeline, 1 facture, 1 résidence EU) ; web `app.athlya.app` + API `api.athlya.app` = **même domaine enregistrable `athlya.app`** → requêtes **same-site** (`SameSite=Lax` suffit), CORS minimal ; cohérent ADR #66 | Maturité OpenNext (suivre les releases) ; build adapter à maintenir                                                             | ✅      |
| Vercel web + CF API                  | Excellente DX Next                                                                                                                                                                                                                | **Cross-site** (classification cookies, CORS large, +surface CSRF) ; 2e vendor hors résidence EU CF ; 2 pipelines non atomiques | ❌      |
| Monolith Worker (web servi par Hono) | Simple en théorie                                                                                                                                                                                                                 | Refacto lourd, perte du runtime Next (RSC/streaming)                                                                            | ❌      |

## Conséquences

- **Domaine** : `app.athlya.app` (web) + `api.athlya.app` (API) sous `athlya.app`. Les deux sont **same-site** (même eTLD+1) → `SameSite=Lax` classe correctement, sans recourir à `SameSite=None`.
- **Cookie refresh inchangé — HOST-ONLY** : on **conserve** le cookie `athlya.refresh` host-only `Path=/api/auth` sur l'origine web. **Ne PAS** ajouter `Domain=.athlya.app` : cela partagerait le refresh avec les sous-domaines tenants `{slug}.athlya.app` et rouvrirait l'exposition CSRF same-site documentée par l'audit S4 (S4-006). La décision d'hébergement n'élargit **pas** la frontière cookie.
- **CORS** : `CORS_ORIGIN=https://app.athlya.app` (déjà supporté par `worker.ts`). L'access token part en `Bearer` (mémoire) ; pas de cookie credential cross-origin requis.
- **Pipeline** : déploiement **ordonné** API → web (cf. runbook unifié `docs/runbooks/deploy-unified.md`).
- **TODO `next.config.ts`** : remplacé par une référence à cet ADR (décision figée ; l'implémentation de l'adapter est une slice dédiée — voir « Plan d'implémentation »).

## Plan d'implémentation (slice dédiée, hors PR décision)

1. `pnpm --filter @athlya/web add -D @opennextjs/cloudflare` + `wrangler`.
2. `apps/web/open-next.config.ts` (preset CF) + `apps/web/wrangler.jsonc` (nom `athlya-web`, assets, compat date).
3. Scripts : `build:cf` (`opennextjs-cloudflare build`) + `deploy:cf` (`wrangler deploy`).
4. CI : étendre `deploy-production.yml` (ou un job web) avec l'ordre API→web + ready gate web.
5. Valider **E2E prod** : login (cookie first-party), appel API cross-subdomain (CORS), logout.

> L'implémentation est volontairement **non incluse** dans la PR de décision : elle modifie l'infra de déploiement et doit être validée par un build/déploiement réel (impossible tant que le quota CI billing #123 bloque). La décision et le runbook sont livrés ; l'adapter suit dans une slice tracée.

## Déclencheurs de réévaluation

- OpenNext CF régresse ou ne suit pas Next 16 → fallback Vercel (accepter le cross-origin + durcir CSRF) documenté.
- Besoin produit incompatible avec le runtime Workers (ISR avancé, etc.).

## Références

- `apps/web/next.config.ts` (TODO résolu → ref ADR)
- `packages/api/src/worker.ts` — CORS `CORS_ORIGIN` + `credentials`
- `docs/security/eu-data-residency-adr.md` (#66)
- `docs/runbooks/deploy-unified.md`
- Audit prod 2026-05-27 — A6
