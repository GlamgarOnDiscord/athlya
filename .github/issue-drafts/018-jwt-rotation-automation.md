## Résumé

Rotation JWT (`POST /admin/jwt/rotate-prepare`) génère keypair mais **persistance = steps manuels wrangler** (`docs/runbooks/rotate-jwt.md`). Erreur humaine = invalidation sessions masse ou clé comprometueuse.

## Comportement observé

- `admin/jwt-rotate-routes.ts` — prepare only
- Audit writer non branché (worker.ts comment L1156-1161)
- Opérateur doit : secret put × 4 + deploy

## Solution proposée

### Phase 1 — Script idempotent

`scripts/rotate-jwt.mjs` :

1. Call rotate-prepare API
2. Output wrangler commands avec confirmation
3. Rollback instructions

### Phase 2 — Automation CI (optionnel)

GitHub Action `workflow_dispatch` avec secrets CF + confirmation environment.

### Phase 3 — Audit

Brancher `appendAudit` sur rotate success.

## Critères d'acceptation

- [ ] Runbook rotate-jwt.md → script automatisé 80%
- [ ] Audit log entry `jwt.rotated` on success
- [ ] Test admin route rotate-prepare (existe) + doc ops

## Priorité

**P2** — avant première rotation prod (90j)

## Références

- Req 25.5 — rotation 90 jours
- `docs/runbooks/rotate-jwt.md`
