## Résumé

Routes `/admin/*` (DLQ, JWT rotate) protégées par `jwtAuth()` + `requireRole('admin')` uniquement. Pas de IP allowlist, pas de Cloudflare Access, pas de step-up MFA.

## Surface exposée

- `GET/POST /admin/dlq/*` — replay/discard messages
- `GET/POST /admin/jwt/*` — rotation clés JWT

## Impact

- **Sévérité** : Medium / P2
- JWT admin volé (XSS, device compromise) → contrôle bus events + rotation keys
- Pas de defense-in-depth ops

## Solution proposée

### Phase 1 — Cloudflare Access

Policy : email domain + MFA sur `api.athlya.app/admin/*`

### Phase 2 — mTLS ou static IP allowlist

Pour on-call scripts uniquement.

### Phase 3 — Audit log obligatoire

JWT rotate doit appeler `appendAudit` (TODO commenté worker.ts L1156)

## Critères d'acceptation

- [ ] CF Access policy documentée runbook
- [ ] Test : non-admin JWT → 403 (existe)
- [ ] Test : admin sans Access (prod) → blocked at edge

## Priorité

**P2** — avant équipe ops > 1 personne
