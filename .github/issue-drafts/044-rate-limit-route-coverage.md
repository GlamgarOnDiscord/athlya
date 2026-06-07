## Résumé

Mutations critiques fail-closed (#65). **Global + reads fail-open**. Revue nécessaire : routes sensibles en read (export status, enumeration) peuvent être abusées si Redis down + routing bug.

**Finding audit** : C7 — gravité **Medium**, priorité **P2**.

## Solution proposée

1. Inventaire toutes routes dans `worker.ts` + policies limiter
2. Matrice route × fail-open/closed × scope (IP/user/tenant)
3. Ajouter fail-closed sur reads coûteux : search, export download, admin stats
4. Test table-driven policies

## Critères d'acceptation

- [ ] Matrice documentée `docs/security/rate-limit-coverage.md`
- [ ] Reads coûteux fail-closed ou WAF
- [ ] Tests policies complets

## Références

- `packages/api/src/worker.ts`
- Audit prod 2026-05-27 — C7

## Priorité

**P2**
