## Résumé

En production, `DB_URL` pointe très probablement vers le rôle Neon **`neondb_owner`** (BYPASSRLS). Toutes les policies `FORCE ROW LEVEL SECURITY` de `0004_rls_hardening.sql` sont **ignorées**. L'isolation multi-tenant repose uniquement sur les filtres Drizzle applicatifs — pas sur la défense en profondeur Postgres.

**Finding audit** : A1 / S1 / S8 — gravité **Critical**, priorité **P0**.

Issue #63 (withTenant code) et #64 (CRON_DB_URL) sont fermées mais le **cutover ops** n'est pas fait.

## Comportement attendu

- Worker API connecté avec le rôle **`athlya_app`** (NOBYPASSRLS)
- `SET LOCAL app.current_tenant_id` / `app.current_user_id` appliqué sur les transactions sensibles
- pgTAP + tests intégration RLS valident la **config déployée**, pas seulement le SQL

## Comportement observé

`docs/runbooks/db-role-switch.md` documente explicitement :

> Tant que `DB_URL` = owner Neon, **RLS n'est pas appliquée**.

Les 6 tests d'isolation intégration passent en CI avec le rôle test — **ne protègent pas** la config prod si le secret wrangler reste owner.

## Impact production

- Oubli de filtre `studio_id` dans une requête Drizzle → **fuite cross-tenant** (IDOR massif)
- Marketing "RGPD-first multi-tenant" **contradictoire** avec la config réelle
- Auditeur externe classera RLS comme **théâtre**

## Solution proposée

### Phase 1 — Pré-cutover (staging)

1. Créer user `athlya_app` sur Neon staging (mot de passe rotatif, vault)
2. Appliquer grants documentés dans `db-role-switch.md` étape 1
3. Mettre à jour secret `DB_URL` staging → connection string `athlya_app`
4. Smoke : login, book, cancel, export, admin DLQ

### Phase 2 — Débloquer audit_log (issue #87 / C1)

Migration `audit_no_insert` → policy INSERT autorisée pour `athlya_app` ou writer SECURITY DEFINER — **prérequis** avant cutover prod.

### Phase 3 — Cutover production

1. Fenêtre maintenance 15 min
2. `wrangler secret put DB_URL` (prod) avec `athlya_app`
3. Vérifier `/health/ready` + booking E2E
4. Rollback documenté : restaurer owner URL si 500 massifs

### Phase 4 — Validation post-cutover

```sql
-- Doit échouer en athlya_app sans GUC :
SELECT * FROM users LIMIT 1; -- 0 rows ou permission denied selon policy
```

Test automatisé post-deploy dans `scripts/smoke-rls-cutover.mjs`.

## Composants touchés

- [ ] Secrets Cloudflare `DB_URL` (staging + production)
- [ ] `docs/runbooks/db-role-switch.md` — cocher étapes exécutées
- [ ] `docs/operations/v1.0.0-launch-checklist.md` — critère RLS réel
- [ ] Dépend de issue C1 (audit_log INSERT)

## Critères d'acceptation

- [ ] Staging tourne 48h avec `athlya_app` sans régression
- [ ] Production cutover exécuté avec rollback testé
- [ ] Aucune requête runtime ne dépend de BYPASSRLS owner
- [ ] Runbook mis à jour avec date + opérateur du cutover
- [ ] Test fumée post-cutover dans CI ou script ops documenté

## Références

- `docs/runbooks/db-role-switch.md`
- `packages/db/migrations/0004_rls_hardening.sql`
- Audit prod 2026-05-27 — findings A1, S1, S8
- Issue fermée #63 (code withTenant) ≠ cutover ops

## Priorité

**P0** — bloquant sécurité multi-tenant avant premier studio pilote payant
