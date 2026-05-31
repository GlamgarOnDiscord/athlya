# Runbook — Déploiement unifié API + Web (issue #139)

Décision d'hébergement : [`deploy-web-adr.md`](../security/deploy-web-adr.md) — web via OpenNext sur Cloudflare Workers, même zone que l'API.

## Topologie cible

| Composant | Worker | Domaine |
|-----------|--------|---------|
| API (Hono) | `athlya-api` | `api.athlya.app` |
| Web (Next/OpenNext) | `athlya-web` | `app.athlya.app` |

Domaine enregistrable commun `athlya.app` → cookies de session first-party `Domain=.athlya.app; SameSite=Lax; Secure`.

## Ordre de déploiement (non atomique → ordonné)

Cloudflare ne donne pas d'atomicité multi-Worker. On **ordonne** pour éviter les fenêtres d'incompatibilité :

1. **Migrations DB** (si nécessaires) — backward-compatible d'abord.
2. **API** (`athlya-api`) — `wrangler deploy --env <env>` + `wait-health-ready.sh` (cf. `deploy-production.yml`). L'API doit être déployée **avant** le web pour qu'un web qui appelle un nouveau contrat trouve l'API à jour.
3. **Web** (`athlya-web`) — `opennextjs-cloudflare build` + `wrangler deploy --env <env>` + ready gate web (`GET /` 200).
4. **Smoke E2E** : login → appel API cross-subdomain → logout.

Rollback : web puis API (ordre inverse), via `wrangler rollback` / `scripts/canary-deploy.mjs rollback`.

## CORS / cookies — checklist prod

- [ ] `CORS_ORIGIN=https://app.athlya.app` sur l'API (`worker.ts` rejette tout le reste hors dev).
- [ ] Cookies session : `Domain=.athlya.app`, `SameSite=Lax`, `Secure`, `HttpOnly`.
- [ ] Préflight OPTIONS `app.athlya.app → api.athlya.app` : `Access-Control-Allow-Credentials: true`, origin echo strict.
- [ ] Pas de `SameSite=None` (first-party suffit en same-site cross-subdomain).
- [ ] E2E : `apps/web/e2e` rejoués contre staging (login/book/cancel).

## État

- **Décision + runbook** : livrés (#139).
- **Implémentation adapter OpenNext** : slice dédiée (cf. ADR § Plan d'implémentation) — bloquée par le quota CI billing (#123) pour la validation build/deploy réelle.

## Références

- [`deploy-web-adr.md`](../security/deploy-web-adr.md)
- [`deploy-production.md`](./deploy-production.md) (API), [`canary-deploy.md`](./canary-deploy.md)
- `.github/workflows/deploy-production.yml`
