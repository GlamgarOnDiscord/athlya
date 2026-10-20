# Runbook : salles, séries récurrentes et conflits de planning (issue #748)

Roadmap v1.4, ligne « Cours en calendrier ».

## Ce qui arrive en base

Une seule migration, **`0051_class_rooms_series.sql`** (expand seulement,
pas de ligne `-- athlya:contract`) :

- table `rooms` (nom unique par studio sans tenir compte de la casse parmi
  les salles actives, capacité facultative 1 à 500, suppression logique
  par `deleted_at`), RLS ENABLE + FORCE, politiques calquées sur `classes`
  (lecture par tout rôle du studio, création et modification par un admin
  du studio), droits `athlya_app` seulement, sans DELETE ;
- colonnes nullables `classes.room_id` (clé étrangère composite vers
  `rooms(id, studio_id)` : une séance ne peut pas pointer vers la salle
  d'un autre studio) et `classes.series_id` ;
- index `classes_room_starts_at_idx`, `classes_coach_starts_at_idx` et
  `classes_series_starts_at_idx`, créés dans la transaction de la
  migration (verrou bref sur `classes`, table petite).

Aucune fonction, aucun SECURITY DEFINER.

## Ordre : la migration AVANT le Worker reservations

Le nouveau Worker lit `room_id` et `series_id` sur chaque liste de
séances et sert `/v1/classes/rooms` et `/v1/classes/series` : sur l'ancien
schéma, `GET /v1/classes` échoue. L'ancien Worker, lui, ignore les
nouvelles colonnes et la nouvelle table : il fonctionne sur le nouveau
schéma pendant le canary.

1. Appliquer la migration sur la base cible. `deploy-production.yml` le
   fait seul, avant le déploiement des Workers, en staging puis en
   production (`node packages/db/scripts/migrate.mjs`). À la main, avec la
   chaîne de connexion du propriétaire du schéma (secret
   `MIGRATION_DB_URL_*`) : `DATABASE_URL=… node packages/db/scripts/migrate.mjs`.
2. Vérifier : `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
   WHERE oid = 'rooms'::regclass;` rend `t, t`, puis
   `node scripts/verify-role-contract.mjs` (variables dans l'en-tête).
3. Déployer le Worker reservations (canary habituel), puis le studio.
   Aucune nouvelle route de zone : tout passe sous `/v1/classes/*`.

Rollback du Worker : sans risque, la migration est expand. Rollback de la
migration (`0051_class_rooms_series.down.sql`) seulement après retour à un
Worker antérieur : les salles et le rattachement des séances à une salle
ou à une série sont perdus, les séances elles-mêmes restent.

## Conflits

La détection (même salle ou même coach sur des créneaux qui se
chevauchent, intervalles semi-ouverts) est un avertissement : l'API
répond 409 `schedule_conflict` avec la liste des séances en cause, et
l'admin peut renvoyer avec `allowConflicts: true`. Elle ne pose pas de
verrou : deux admins qui planifient au même instant peuvent encore se
chevaucher. Les réservations et la capacité n'en dépendent pas.
