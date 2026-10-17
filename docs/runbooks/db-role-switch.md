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
- [ ] La migration `0032_service_definer_functions.sql` est appliquée **et** le Worker qui l'appelle est déployé (issue #224). Sans elle, sous `athlya_app`, le login/register/reset, la résolution des destinataires de notifications et la cascade RGPD voient zéro ligne (FORCE RLS sans claims). Vérification : `SELECT count(*) FROM pg_proc WHERE proowner = 'athlya_owner'::regrole AND proname ~ '^(auth|rgpd|notification)_'` → 13.
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

### 6. Smoke test (API)

```powershell
# Endpoint public
curl https://api.athlya.app/health

# Endpoint authentifié (utiliser un access token valide)
curl -H "authorization: Bearer $TOKEN" https://api.athlya.app/v1/members/me
curl -H "authorization: Bearer $TOKEN" https://api.athlya.app/v1/classes?from=2099-01-01T00:00:00Z&to=2099-03-01T00:00:00Z
```

Toutes les routes doivent répondre normalement (200 / 4xx selon le contexte). Vérifier les logs Cloudflare pour absence d'erreur SQL `permission denied`.

### 6b. Smoke test RLS (DATABASE_URL athlya_app)

Après bascule du secret, valider que le rôle runtime **n'a pas** BYPASSRLS et que les policies filtrent :

```powershell
$env:DATABASE_URL = "postgresql://athlya_app:...@..."
node scripts/smoke-rls-cutover.mjs

# Optionnel — vérifier qu'un admin voit les users de son studio :
$env:SMOKE_STUDIO_ID = "<studio-uuid>"
$env:SMOKE_ADMIN_ID = "<admin-user-uuid>"
node scripts/smoke-rls-cutover.mjs
```

Exit code 0 requis avant de considérer le cutover terminé (issue #117).

### 6c. Contrat des rôles runtime (issue #117)

Rejoue **chaque charge de travail** sous le rôle réellement déployé, dans des
transactions toujours annulées (rien n'est persisté) : register, lookup login,
destinataire de notification, enqueue d'export (claims tenant), claim + lecture
par le worker d'export, suppression de compte + événement, cascade RGPD, puis
les privilèges du drain sous `athlya_cron`.

```powershell
$env:APP_DATABASE_URL = "postgresql://athlya_app:...@.../athlya"
$env:CRON_DATABASE_URL = "postgresql://athlya_cron:...@.../athlya"
$env:SMOKE_STUDIO_SLUG = "<slug d'un studio existant>"
pnpm verify:role-contract
```

Prérequis : migrations `0031` → `0035` appliquées. Les **trois** variables sont
obligatoires : sans `CRON_DATABASE_URL` le script échoue (exit 1) au lieu de
sauter la vérification du rôle `athlya_cron`. Il échoue aussi si une connexion
est `SUPERUSER` ou `BYPASSRLS`. Exit 0 sur staging **et** production avant de
déclarer le cutover terminé ; le même contrat tourne en CI (`pgtap.yml`) sur
une base éphémère à chaque changement de migration.

### Sign-off cutover

| Environnement | Date | Opérateur | `verify:role-contract` | Soak 48 h sans régression | Rollback testé |
| ------------- | ---- | --------- | ---------------------- | ------------------------- | -------------- |
| staging       |      |           |                        |                           |                |
| production    |      |           |                        | n/a                       |                |

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

---

## ⚠️ Piège plateforme Neon — rôles Console héritent de BYPASSRLS

**Découvert le 2026-06-16, lors du cutover réel.** `athlya_app` avait été créé
via la Neon Console (Roles & Databases → Add role) sur les deux branches. Le
smoke test post-cutover a révélé `rolbypassrls = true` malgré la migration
`0004_rls_hardening.sql` qui tente `ALTER ROLE athlya_app ... NOBYPASSRLS`.

**Cause** : tout rôle créé via la Neon Console, l'API ou le CLI est
automatiquement membre de `neon_superuser`, qui porte `BYPASSRLS`. Seuls les
rôles créés **par une requête SQL `CREATE ROLE`** (psql, pgAdmin, ou tout
client SQL — pas le SQL Editor de la Console qui est aussi un client SQL et
fonctionne correctement) échappent à cette adhésion automatique.

**`ALTER ROLE` est également bloqué** sur un rôle existant créé via Console —
`neondb_owner` n'a pas l'option ADMIN nécessaire (`permission denied to alter
role` / `permission denied to drop role`, car le propriétaire effectif de
l'ADMIN option est un rôle interne Neon `cloud_admin`).

**Fix appliqué** :

1. Supprimer le rôle existant via la Neon Console (`Roles & Databases` → `⋮`
   sur `athlya_app` → **Delete role**) — `neondb_owner` ne peut pas le DROP
   en SQL.
2. Recréer via SQL, en tant que `neondb_owner`, depuis un client direct (pas
   le SQL Editor de Console) :
   ```sql
   CREATE ROLE athlya_app LOGIN PASSWORD '...'
     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
   ```
3. Ré-appliquer tous les GRANTs (capturés depuis l'ancien rôle via
   `information_schema.table_privileges` avant suppression, pour ne rien
   oublier — voir migrations 0004/0010/0011 pour la liste canonique).
4. Mettre à jour le secret `DB_URL` avec le nouveau mot de passe.
5. Re-valider avec `node scripts/smoke-rls-cutover.mjs` → `rolbypassrls:
false` attendu.

**À ne jamais refaire** : créer/recréer un rôle applicatif via la Neon
Console si NOBYPASSRLS est requis. Toujours passer par `CREATE ROLE` en SQL
direct.

### Bug corrigé dans le smoke test lui-même

`scripts/smoke-rls-cutover.mjs` référençait `pg_policies.polname`, qui
n'existe pas (`pg_policies` est une vue, sa colonne est `policyname` ; `polname`
est la colonne du catalogue brut `pg_policy`). Corrigé en même temps que ce
cutover.

### Cutover exécuté

- **Date** : 2026-06-16
- **Opérateur** : ops automation (session Claude Code, autorisation explicite
  utilisateur)
- **Environnements** : staging (`br-lively-boat-alqy5lyt`) + production
  (`br-sweet-sunset-alxstab9`), projet Neon `athlya-dev` (`solitary-dew-81017827`)
- **Résultat** : `node scripts/smoke-rls-cutover.mjs` exit 0 sur les deux,
  `rolbypassrls: false` confirmé, policy `audit_app_insert` active, SELECT non
  scopé sur `users` renvoie 0 ligne.
- **Non couvert** : validation HTTP end-to-end (login/booking via l'API) —
  bloquée par l'allowlist stricte du header `Host` (`worker.ts`, issue #244),
  qui n'accepte que `api.athlya.app` / `staging.api.athlya.app`. Aucun domaine
  custom n'est provisionné (projet open-source sans nom de domaine acheté à
  ce jour). À refaire une fois un domaine réel disponible.
