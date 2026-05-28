# Runbook — DB role switch (`neondb_owner` → `athlya_app`)

**Owner :** Backend / SRE
**Severité cutover :** Standard change (non-disruptif si l'ordre des étapes est respecté).
**Spec :** `tasks.md` Epic B2 — RLS hardening (Req 13.6, H1).

---

## Pourquoi

En l'état actuel (pré-B2 cutover), `DATABASE_URL` côté Cloudflare Workers pointe sur `neondb_owner` — le rôle propriétaire de la DB Neon, qui **bypass RLS par défaut**. Les policies RLS de `0001_rls.sql` et `0004_rls_hardening.sql` ne sont donc jamais appliquées en pratique. Un bug applicatif (oubli de `WHERE studio_id = ?`) leakerait des rows entre studios sans filet de sécurité au niveau DB.

La migration `0004_rls_hardening.sql` prépare le terrain :

1. Élève le rôle `athlya_app` (créé NOLOGIN par 0003) en LOGIN + `NOBYPASSRLS`.
2. Lui donne les grants applicatifs (SELECT/INSERT/UPDATE/DELETE) sur les tables tenant-scoped.
3. Restate `FORCE ROW LEVEL SECURITY` sur toutes les tables.

Tant que `DB_URL` pointe sur `neondb_owner`, ces changements sont **non-disruptifs** (FORCE n'a pas d'effet sur un rôle BYPASSRLS). Ce runbook décrit la bascule à proprement parler.

---

## Pré-requis

- [ ] La migration `0004_rls_hardening.sql` est appliquée en production.
- [ ] Le test d'isolation `multi-tenant-isolation.integration.test.ts` est vert sur la branche déployée.
- [ ] Les 387+ tests api sont verts.
- [ ] Un opérateur a accès Neon Console (rôle propriétaire) et Cloudflare Workers Dashboard (Secrets).
- [ ] Une fenêtre de maintenance courte (~5 min, pas d'interruption attendue) est annoncée si l'ops process l'exige.

---

## Étapes

### 1. Provisionner le password `athlya_app` (Neon Console)

Connectez-vous à Neon Console comme `neondb_owner`, ouvrez le SQL editor de la DB cible, et exécutez :

```sql
ALTER ROLE athlya_app PASSWORD 'STRONG_RANDOM_64_CHARS';
```

Le password doit être :

- 64 caractères minimum, généré par `openssl rand -base64 48` ou équivalent.
- Stocké immédiatement dans le password manager d'équipe (1Password / Bitwarden).
- **Jamais** committé.

### 2. Relâcher la policy `audit_no_insert`

**Tension connue** (cf. commentaire en tête de `0004_rls_hardening.sql`) : la policy `audit_no_insert WITH CHECK (false)` installée par `0001_rls.sql` bloque les INSERTs sur `audit_log` pour tout rôle FORCEd. Une fois `DB_URL` basculé sur `athlya_app`, les writes audit existants (consents update, etc.) échoueront.

Avant la bascule, appliquer la migration **`0011_audit_log_app_insert.sql`** (slice B2-bis, issue #118) qui remplace la policy par :

```sql
DROP POLICY IF EXISTS "audit_no_insert" ON "audit_log";
CREATE POLICY "audit_app_insert" ON "audit_log"
    FOR INSERT
    WITH CHECK (true); -- grants + immutability trigger restreignent UPDATE/DELETE
```

> Cette étape est **obligatoire** avant l'étape 3. Si elle est sautée, les requêtes qui touchent l'audit log (PATCH /v1/me/consents notamment) renverront 500.

### 3. Construire la nouvelle connection string

Format Neon :

```
postgresql://athlya_app:<password>@<host>/<db>?sslmode=require
```

Vérifiez en local que la string fonctionne :

```powershell
$env:DATABASE_URL = "postgresql://athlya_app:..."
node packages/db/scripts/inspect-user.mjs <some-email>
```

La query doit renvoyer la row attendue (le SELECT passe sur `users` filter par email, RLS est compatible avec `app.user_id` non set car le helper utilise `current_setting(..., true)`).

### 4. Mettre à jour le secret Cloudflare Workers

```powershell
# Production
pnpm --filter @athlya/api exec wrangler secret put DB_URL --env production
# Coller la nouvelle connection string quand demandé

# Staging
pnpm --filter @athlya/api exec wrangler secret put DB_URL --env staging
```

Ne pas toucher `MIGRATION_DB_URL` côté Worker — il n'est pas lu par le runtime.

### 5. Déployer

```powershell
pnpm --filter @athlya/api exec wrangler deploy --env production
```

Le deploy redémarre les isolates ; aucun downtime attendu.

### 6. Smoke test

```powershell
# Endpoint public
curl https://api.athlya.app/health

# Endpoint authentifié (utiliser un access token valide)
curl -H "authorization: Bearer $TOKEN" https://api.athlya.app/v1/members/me
curl -H "authorization: Bearer $TOKEN" https://api.athlya.app/v1/classes?from=2099-01-01T00:00:00Z&to=2099-03-01T00:00:00Z
```

Toutes les routes doivent répondre normalement (200 / 4xx selon le contexte). Vérifier les logs Cloudflare pour absence d'erreur SQL `permission denied`.

### 7. Vérification RLS active

Exécuter en SQL editor (en tant que `neondb_owner`) :

```sql
SET ROLE athlya_app;
SET LOCAL app.user_id   = '00000000-0000-4000-8000-000000000000';
SET LOCAL app.studio_id = '00000000-0000-4000-8000-000000000000';
SET LOCAL app.role      = 'member';
SELECT count(*) FROM users;        -- doit renvoyer 0 (aucun user n'a cet ID/studio)
SELECT count(*) FROM reservations; -- doit renvoyer 0 idem
RESET ROLE;
```

Si les `count(*)` renvoient > 0, RLS n'est PAS active — investiguer (voir Rollback).

---

## Rollback

Si le smoke test échoue ou si un volume anormal d'erreurs SQL apparaît dans les logs :

### 1. Re-pointer `DB_URL` sur `neondb_owner`

```powershell
pnpm --filter @athlya/api exec wrangler secret put DB_URL --env production
# Coller l'ancienne connection string neondb_owner
pnpm --filter @athlya/api exec wrangler deploy --env production
```

### 2. (Optionnel) Roll back la migration 0004

Si la cause est suspecte côté migration :

```powershell
$env:MIGRATION_DATABASE_URL = "postgresql://neondb_owner:...@..."
psql $env:MIGRATION_DATABASE_URL -f packages/db/migrations/0004_rls_hardening.down.sql
```

Le `.down.sql` revoke tous les grants et redémote `athlya_app` à NOLOGIN.

### 3. Investigation post-mortem

Vérifier dans cet ordre :

- `\du athlya_app` dans psql — attributs cohérents ?
- `\dp users` — grants présents ?
- `SELECT * FROM pg_policies WHERE tablename = 'audit_log';` — la policy `audit_no_insert` est-elle relâchée ?
- Logs Cloudflare → quel SQLSTATE ? `42501` = permission denied, `0L000` = invalid_grantor, etc.

---

## Post-cutover

- [ ] Tagger la version Worker déployée (`v1.X.Y-rls-hardened`).
- [ ] Mettre à jour le README ops avec la date de cutover.
- [ ] Cocher le critère d'acceptation B2 final dans `tasks.md` (slice B2-prod).
- [ ] Programmer une rotation password `athlya_app` à 90 jours (calendrier ops).
