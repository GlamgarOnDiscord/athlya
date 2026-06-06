# Admin API access — defense in depth (issue #121)

Surface `/admin/*` : DLQ, outbox stats, JWT rotation. Protégée applicativement par `jwtAuth()` + `requireRole('admin')`. Ce runbook ajoute la couche **Cloudflare Access** (issue #74, enforcement #121).

## Routes concernées

| Route                     | Risque si JWT admin volé    |
| ------------------------- | --------------------------- |
| `GET/POST /admin/dlq/*`   | Replay / discard bus events |
| `GET /admin/outbox/stats` | Fuite métriques ops         |
| `GET/POST /admin/jwt/*`   | Préparation rotation clés   |

## Phase 1 — Cloudflare Access (production)

1. Zero Trust → **Access** → Application → Add application.
2. **Domain** : `api.athlya.app` — path `/admin/*` (ou sous-chemin dédié si split hostname ops).
3. **Policy** :
   - Include : emails `@<votre-domaine-ops>` (ou IdP groupe `athlya-ops`).
   - Require : MFA (Warp optionnel pour devices gérés).
4. **Bypass** : aucun pour `staging` tant que JWT admin de staging n'est pas considéré public — dupliquer la policy sur `staging.api.athlya.app/admin/*` avec liste plus large si besoin QA.
5. Vérifier (automatisé) :

```powershell
$env:ATHLYA_API_URL = "https://api.athlya.app"
$env:ATHLYA_ADMIN_TOKEN = "<admin-jwt>"
node scripts/smoke-cf-access-admin.mjs
# exit 0 = edge block OK ; exit 1 = JWT seul atteint le Worker (Access absent)
```

Manuel : `curl -i` sans cookie Access → **403/302** page CF, pas `200` JSON outbox stats.

Tests automatisés existants : membre/coach → 403 JSON (`dlq-routes.test.ts`, `jwt-rotate-routes.test.ts`, `outbox-routes.test.ts`).

## Phase 2 — Scripts on-call (optionnel)

- IP allowlist CF WAF rule **en plus** d'Access pour jobs CI internes (replay DLQ).
- mTLS service token Access pour `wrangler`/scripts — pas de JWT humain en cron.

## Phase 3 — Audit JWT rotate

`POST /admin/jwt/rotate-prepare` écrit `audit_log` (`jwt.key.rotation_prep`, issue #127). Policy INSERT corrigée en migration `0011` (issue #118).

## Onboarding on-call

1. Compte IdP / email ops autorisé dans la policy Access.
2. MFA activé sur le compte Cloudflare Zero Trust.
3. Depuis poste autorisé : login Access → `node scripts/smoke-cf-access-admin.mjs` avec `EXPECT_ACCESS=false` et JWT → doit retourner 200 JSON (validation inverse manuelle).
4. Lire `docs/runbooks/rotate-jwt.md` avant toute rotation prod.

## Checklist déploiement

- [ ] Access policy prod (`api.athlya.app/admin/*`) + staging (`staging.api.athlya.app/admin/*`)
- [ ] Policy ID noté (vault ops)
- [ ] `node scripts/smoke-cf-access-admin.mjs` exit 0 prod + staging (JWT sans cookie)
- [ ] Rotation JWT testée depuis poste autorisé Access
- [ ] Alerte CF Access denies spike (dashboard Zero Trust)

## Références

- `packages/api/src/worker.ts` — chaîne `/admin/*`
- `docs/runbooks/rotate-jwt.md`
- Issues #74, #121
