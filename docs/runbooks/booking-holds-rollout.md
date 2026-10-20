# Runbook : mise en service des holds de place et du fencing (issue #723)

Phase B de l'anti-surréservation (#713). Conception :
[`docs/architecture/booking-concurrency.md`](../architecture/booking-concurrency.md).

## Ce qui arrive en base

Une seule migration, **`0050_booking_holds_fencing.sql`** (expand seulement,
pas de ligne `-- athlya:contract`) :

- valeur d'enum `reservation_status = 'pending'` et colonne nullable
  `reservations.hold_expires_at` ;
- index unique partiel `reservations_class_user_live_unique` et index
  `reservations_hold_expires_at_idx`, créés dans la transaction de la
  migration (verrou bref sur `reservations` pendant la construction) ;
- `enforce_class_capacity()` réécrite (confirmés + holds actifs) et
  nouveau trigger `classes_guard_schedule` ;
- fonctions `reservation_lock_class_for_booking` (athlya_app) et
  `reservation_sweep_holds_and_promote` (athlya_cron) ;
  `reservation_promote_oldest_waitlist` et `capacity_reconcile_snapshot`
  comptent les holds actifs.

## Ordre : la migration AVANT le Worker

Le nouveau Worker lit `hold_expires_at` et la valeur `pending` (rejeu d'une
réservation, modification de séance, cron). Sur l'ancien schéma, ces
chemins échouent. L'ancien Worker, lui, fonctionne sur le nouveau schéma :
il n'écrit jamais de hold, fait déjà avancer `version` à chaque PATCH et
garde son contrôle de capacité.

1. Appliquer la migration sur la base cible. `deploy-production.yml` le
   fait seul, avant le déploiement des Workers, en staging puis en
   production (`node packages/db/scripts/migrate.mjs`). À la main, avec
   la chaîne de connexion du propriétaire du schéma (secret
   `MIGRATION_DB_URL_*`) : `DATABASE_URL=… node packages/db/scripts/migrate.mjs`.
2. Vérifier les rôles réels : `node scripts/verify-role-contract.mjs`
   (variables dans l'en-tête du script). Les lignes « seat hold » et
   « hold and waitlist sweep » doivent être OK.
3. Déployer les Workers (canary habituel). Le cron du Worker principal
   appelle le balayage à chaque tick.
4. Contrôler dans Axiom le log du balayage, une ligne par minute :
   `capacity reconcile: hold and waitlist sweep`, avec les compteurs
   `expiredHolds` et `promotedWaiters`. Un `hold sweep failed` répété
   veut dire que la migration manque sur cette base.

Rollback du Worker : sans risque, la migration est expand. Rollback de la
migration (`0050_booking_holds_fencing.down.sql`) seulement après retour à
un Worker antérieur : les holds ouverts sont annulés, la valeur d'enum
`pending` reste (PostgreSQL ne sait pas la retirer).

## Écritures SQL directes sur `classes`

Le trigger `classes_guard_schedule` s'applique à tout le monde, superuser
compris. Pour modifier `capacity` ou `starts_at` à la main :

```sql
UPDATE classes SET capacity = 30, version = version + 1 WHERE id = '<classId>';
```

Refus possibles : `class_version_not_bumped` (oubli de `version + 1`),
`class_capacity_below_booked` (moins de places que de confirmés + holds
actifs), `class_already_started`, `class_starts_in_past`.

## Contract ultérieur (hors de cette migration)

Supprimer l'index `reservations_class_user_active_unique` (0028), redondant
avec `reservations_class_user_live_unique`, une fois l'ancien Worker parti.
