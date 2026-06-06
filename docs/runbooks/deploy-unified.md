# Runbook — Déploiement unifié API + Web (issue #139)

Décision d'hébergement : [`deploy-web-adr.md`](../security/deploy-web-adr.md) — web via OpenNext sur Cloudflare Workers, même zone que l'API.

## Topologie cible

| Composant           | Worker       | Domaine          |
| ------------------- | ------------ | ---------------- |
| API (Hono)          | `athlya-api` | `api.athlya.app` |
| Web (Next/OpenNext) | `athlya-web` | `app.athlya.app` |

Domaine enregistrable commun `athlya.app` → requêtes web↔API **same-site** (`SameSite=Lax` suffit). Le cookie refresh reste **host-only** sur l'origine web (cf. ci-dessous) — pas de partage cross-subdomain.

## Ordre de déploiement (non atomique → ordonné)

Cloudflare ne donne pas d'atomicité multi-Worker. On **ordonne** pour éviter les fenêtres d'incompatibilité :

1. **Migrations DB** (si nécessaires) — backward-compatible d'abord.
2. **API** (`athlya-api`) — `wrangler deploy --env <env>` + `wait-health-ready.sh` (cf. `deploy-production.yml`). L'API doit être déployée **avant** le web pour qu'un web qui appelle un nouveau contrat trouve l'API à jour.
3. **Web** (`athlya-web`) — `opennextjs-cloudflare build` + `wrangler deploy --env <env>` + ready gate web (`GET /` 200).
4. **Smoke E2E** : login → appel API cross-subdomain → logout.

Rollback : web puis API (ordre inverse), via `wrangler rollback` / `scripts/canary-deploy.mjs rollback`.

## CORS / cookies — checklist prod

- [ ] `CORS_ORIGIN=https://app.athlya.app` sur l'API (`worker.ts` rejette tout le reste hors dev).
- [ ] Cookie refresh **inchangé / host-only** : `athlya.refresh`, `Path=/api/auth`, `SameSite=Lax`, `HttpOnly`, `Secure`, **sans `Domain`** (cf. `apps/web/src/lib/auth/cookies.ts`). **Ne PAS** ajouter `Domain=.athlya.app` (partagerait le refresh avec `{slug}.athlya.app` → CSRF S4-006).
- [ ] Access token en mémoire (`token-store.ts`), envoyé en `Bearer` → pas de cookie credential cross-origin.
- [ ] Pas de `SameSite=None` (same-site suffit ; web et API sous `athlya.app`).
- [ ] E2E : `apps/web/e2e` rejoués contre staging (login/book/cancel).

## État

- **Décision + runbook** : livrés (#139).
- **Implémentation adapter OpenNext** : slice dédiée (cf. ADR § Plan d'implémentation) — bloquée par le quota CI billing (#123) pour la validation build/deploy réelle.

## Références

- [`deploy-web-adr.md`](../security/deploy-web-adr.md)
- [`deploy-production.md`](./deploy-production.md) (API), [`canary-deploy.md`](./canary-deploy.md)
- `.github/workflows/deploy-production.yml`
