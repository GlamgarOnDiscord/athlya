## Résumé

Issue #74 a livré `docs/runbooks/admin-access.md` (procédure Cloudflare Access). **Aucune policy Access n'est appliquée** sur `api.*/admin/*` en production — protection = JWT `role=admin` uniquement.

**Finding audit** : S2 — gravité **High**, priorité **P0**.

## Surface exposée

| Route                     | Risque JWT admin volé       |
| ------------------------- | --------------------------- |
| `GET/POST /admin/dlq/*`   | Replay / discard bus events |
| `GET /admin/outbox/stats` | Reconnaissance infra        |
| `GET/POST /admin/jwt/*`   | Préparation rotation clés   |

## Comportement attendu

- Cloudflare Zero Trust Access policy sur `/admin/*`
- MFA + email domain allowlist (équipe ops)
- Requête sans session Access → **403 edge** avant Worker
- JWT admin reste requis en couche 2 (defense in depth)

## Comportement observé

Runbook documente les étapes dashboard — **non exécutées**. Attaquant avec JWT admin valide (XSS studio, device compromise) accède à DLQ + JWT rotate sans friction edge.

## Solution proposée

### Phase 1 — Cloudflare Access

1. Zero Trust → Applications → Self-hosted
2. Domain : `api.athlya.app` (staging : `api-staging.athlya.app`)
3. Path : `/admin/*`
4. Policy : emails `@athlya.app` + MFA required

### Phase 2 — Validation

```bash
# Sans cookie Access — doit 403/302 login CF
curl -i https://api.athlya.app/admin/dlq/stats \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Avec session Access + JWT → 200.

### Phase 3 — Runbook ops

Mettre à jour `admin-access.md` : screenshots policy ID, procédure onboarding on-call.

## Composants touchés

- [ ] Cloudflare Zero Trust dashboard
- [ ] `docs/runbooks/admin-access.md`
- [ ] `docs/operations/v1.0.0-launch-checklist.md`

## Critères d'acceptation

- [ ] Policy Access active staging + production
- [ ] Test : JWT seul → blocked at edge
- [ ] Test : Access + JWT → OK
- [ ] Runbook onboarding on-call documenté

## Références

- `docs/runbooks/admin-access.md`
- Issue fermée #74 (doc only)
- Audit prod 2026-05-27 — S2

## Priorité

**P0** — surface ops critique sans defense-in-depth
