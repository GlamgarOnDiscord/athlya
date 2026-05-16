# @athlya/db

Schéma Drizzle ORM, migrations, client tenant-aware et helpers de repository
pour la base de données PostgreSQL Athlya.

## Scripts

| Script                   | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `pnpm test`              | Suite Vitest unitaire (client JS, idempotency store, helpers outbox).                      |
| `pnpm test:rls`          | Suite pgTAP RLS — nécessite un Postgres live avec `pgtap`. Voir ci-dessous.                |
| `pnpm lint:rls-coverage` | Vérifie que chaque `CREATE POLICY` dans `0001_rls.sql` est référencé par un fichier pgTAP. |
| `pnpm build`             | Émet `dist/` via `tsc -p tsconfig.build.json`.                                             |

## Tests Row-Level Security (tâche 2.6)

Les politiques RLS se trouvent dans [`migrations/0001_rls.sql`](migrations/0001_rls.sql)
et sont répertoriées dans [`migrations/README.md`](migrations/README.md). La suite pgTAP
sous [`tests/rls/`](tests/rls) couvre un scénario cross-tenant par politique : chaque
fichier par table ouvre un bloc `BEGIN; SELECT plan(N);`, définit un contexte tenant avec
le helper `test_set_tenant`, exécute des assertions `is` / `is_empty` / `throws_ok` /
`lives_ok` et effectue un rollback de la transaction pour que la suite soit idempotente.

### Exécution locale avec Docker

L'image `pgtap/pgtap` embarque Postgres 16 avec l'extension `pgtap` préinstallée,
ce qui est le moyen le plus rapide d'exécuter la suite sur une machine de développement.

```sh
# 1. Démarrer un Postgres éphémère
docker run --rm -d --name athlya-pg \
    -e POSTGRES_PASSWORD=test -p 5432:5432 pgtap/pgtap

# 2. Pointer le script dessus
export DATABASE_URL=postgres://postgres:test@localhost:5432/postgres

# 3. Lancer la suite
pnpm --filter @athlya/db test:rls

# 4. Nettoyer
docker stop athlya-pg
```

Le script s'exécute en trois étapes :

1. `node scripts/lint-rls-coverage.mjs` — échoue rapidement si une politique de
   `0001_rls.sql` n'est référencée par aucun fichier de test.
2. `psql … -f migrations/0000_init.sql` et `-f migrations/0001_rls.sql`
   — applique le schéma et les politiques RLS à la base vide.
3. `psql … -f tests/rls/run-all.sql` — alimente deux studios et exécute chaque
   fichier pgTAP par table.

### Garantie de couverture

`scripts/lint-rls-coverage.mjs` est invoqué à la fois depuis `test-rls.sh` et depuis
le script standalone `pnpm lint:rls-coverage`. Il parse chaque `CREATE POLICY "<name>"`
de `0001_rls.sql` et recherche ce nom dans les tests sous `tests/rls/` ; toute politique
manquante fait échouer le build. Cela maintient l'honnêteté de la suite de tests à chaque
ajout d'une nouvelle politique.

### Ce que couvre chaque fichier de test

| Fichier                | Politiques couvertes                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `00_bootstrap.sql`     | Configuration des extensions, données de seed, fonctions helper (sans assertions).                 |
| `studios.sql`          | `studios_read_own_tenant`                                                                          |
| `users.sql`            | `users_read_own`, `users_read_same_studio`, `users_update_own`, `users_update_admin`               |
| `classes.sql`          | `classes_read_same_studio`, `classes_insert_admin`, `classes_update_admin`, `classes_delete_admin` |
| `reservations.sql`     | `reservations_read_own`, `reservations_read_admin_same_studio`, `reservations_insert_own`,         |
|                        | `reservations_update_own`, `reservations_update_admin`                                             |
| `workout_sessions.sql` | `workout_sessions_read_own`, `workout_sessions_insert_own`, `workout_sessions_update_own`,         |
|                        | `workout_sessions_delete_own`                                                                      |
| `audit_log.sql`        | `audit_admin_only`, `audit_no_insert`, `audit_no_update`, `audit_no_delete` (chemin RLS) ainsi que |
|                        | le trigger `audit_log_immutable()` (testé avec RLS désactivé dans la transaction).                 |
| `push_tokens.sql`      | `push_tokens_read_own`, `push_tokens_insert_own`, `push_tokens_delete_own`                         |
| `idempotency_keys.sql` | `idempotency_keys_read_own`, `idempotency_keys_insert_own`, `idempotency_keys_delete_own`          |
| `outbox.sql`           | `outbox_admin_only` ainsi que l'absence délibérée de politiques INSERT/UPDATE/DELETE.              |

### Intégration CI

La suite pgTAP est prévue pour s'exécuter sur chaque PR qui touche
`packages/db/migrations/**`. La tâche 13.4 câble le job GitHub Actions ; pour
l'instant le script est accessible en ligne de commande et exposé comme script npm
pour pouvoir être invoqué depuis n'importe quel runner CI.
