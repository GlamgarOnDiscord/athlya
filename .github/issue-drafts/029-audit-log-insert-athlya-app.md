## Résumé

La policy RLS `audit_no_insert` sur `audit_log` (`WITH CHECK (false)`) **bloque tout INSERT** depuis le contexte tenant `athlya_app`. Le runbook `db-role-switch.md` étape 2 exige une migration avant cutover RLS.

**Finding audit** : C1 — gravité **Critical** (couplé à A1), priorité **P0**.

Sans fix : PATCH consents, audit trail compliance → **500** dès cutover `athlya_app`.

## Comportement attendu

- `appendAudit()` fonctionne dans une transaction tenant (`athlya_app` + GUC set)
- INSERT audit_log tracé pour actions sensibles (consent, export, admin)
- pgTAP confirme INSERT autorisé via chemin applicatif, SELECT restreint

## Comportement observé

```sql
-- packages/db/migrations/0001_rls.sql
CREATE POLICY "audit_no_insert" ON "audit_log"
  FOR INSERT WITH CHECK (false);
```

Commentaire migration `0004_rls_hardening.sql` L148-156 : slice **B2-bis** prévue, **non livrée**.

Tests pgTAP (`audit_log.sql`) vérifient que INSERT **échoue** — correct pour RLS strict, **incorrect** pour cutover sans writer alternatif.

## Impact production

- Cutover `athlya_app` (issue #87) **impossible** sans casser audit trail
- Conformité RGPD / traçabilité admin **incomplète**
- `appendAudit` no-op ou exception selon chemin code

## Solution proposée

### Option A — Policy INSERT tenant-scoped (recommandée)

```sql
DROP POLICY "audit_no_insert" ON audit_log;
CREATE POLICY "audit_insert_tenant" ON audit_log
  FOR INSERT
  WITH CHECK (
    studio_id = current_setting('app.current_tenant_id', true)::uuid
  );
```

### Option B — SECURITY DEFINER function

```sql
CREATE FUNCTION append_audit(...) RETURNS void
  SECURITY DEFINER SET search_path = public
  AS $$ ... $$;
REVOKE ALL ON FUNCTION append_audit FROM PUBLIC;
GRANT EXECUTE ON append_audit TO athlya_app;
```

### Option C — Writer BYPASSRLS dédié

Secret `AUDIT_DB_URL` séparé — plus complexe ops, éviter si A ou B suffisent.

### Tests

- Étendre `packages/db/tests/rls/audit_log.sql`
- Test intégration API : consent PATCH → row audit_log visible admin

## Composants touchés

- [ ] `packages/db/migrations/0010_audit_insert_policy.sql` (nouveau)
- [ ] `packages/db/tests/rls/audit_log.sql`
- [ ] `packages/api/src/adapters/*` — vérifier `appendAudit` appelé
- [ ] `docs/runbooks/db-role-switch.md` étape 2

## Critères d'acceptation

- [ ] Migration appliquée staging + prod
- [ ] pgTAP vert : INSERT autorisé avec GUC, interdit sans GUC
- [ ] Smoke cutover staging : consents + audit OK
- [ ] Issue #87 (RLS cutover) débloquée

## Références

- `packages/db/migrations/0004_rls_hardening.sql` L148-156
- `packages/db/tests/rls/audit_log.sql`
- Audit prod 2026-05-27 — finding C1

## Priorité

**P0** — prérequis cutover RLS
