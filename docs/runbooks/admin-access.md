# Admin API access — defense in depth

Surface `/admin/*` : DLQ, outbox stats, JWT rotation. Protégée applicativement par `jwtAuth()` + `requireRole('admin')`. Ce runbook ajoute la couche **Cloudflare Access** (issue #74).

## Routes concernées

| Route                         | Risque si JWT admin volé      |
| ----------------------------- | ----------------------------- |
| `GET/POST /admin/dlq/*`       | Replay / discard bus events   |
| `GET /admin/outbox/stats`     | Fuite métriques ops           |
| `GET/POST /admin/jwt/*`       | Préparation rotation clés     |

## Phase 1 — Cloudflare Access (production)

1. Zero Trust → **Access** → Application → Add application.
2. **Domain** : `api.athlya.app` — path `/admin/*` (ou sous-chemin dédié si split hostname ops).
3. **Policy** :
   - Include : emails `@<votre-domaine-ops>` (ou IdP groupe `athlya-ops`).
   - Require : MFA (Warp optionnel pour devices gérés).
4. **Bypass** : aucun pour `staging` tant que JWT admin de staging n'est pas considéré public — dupliquer la policy sur `staging.api.athlya.app/admin/*` avec liste plus large si besoin QA.
5. Vérifier : `curl -H "Authorization: Bearer <admin-jwt>" https://api.athlya.app/admin/dlq/stats` **sans** cookie Access → **403** page CF (pas seulement 403 JSON API).

Tests automatisés existants : membre/coach → 403 JSON (`dlq-routes.test.ts`, `jwt-rotate-routes.test.ts`, `outbox-routes.test.ts`).

## Phase 2 — Scripts on-call (optionnel)

- IP allowlist CF WAF rule **en plus** d'Access pour jobs CI internes (replay DLQ).
- mTLS service token Access pour `wrangler`/scripts — pas de JWT humain en cron.

## Phase 3 — Audit JWT rotate

`POST /admin/jwt/rotate-prepare` doit écrire `audit_log` (`jwt.rotate.prepared`). Bloqué côté DB par RLS `audit_no_insert` pour `athlya_app` — nécessite rôle BYPASSRLS ou fonction SECURITY DEFINER (slice B2-bis). En attendant : journaliser côté operator (`docs/runbooks/rotate-jwt.md` checklist) + Sentry breadcrumb manuel.

## Checklist déploiement

- [ ] Access policy prod + staging documentée (captures dans vault ops).
- [ ] Rotation JWT testée depuis poste autorisé Access.
- [ ] Alerte si spike `403 admin_required` + Access denies (dashboard CF).

## Références

- `packages/api/src/worker.ts` — chaîne `/admin/*`
- `docs/runbooks/rotate-jwt.md`
- Issue #74
