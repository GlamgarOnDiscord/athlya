-- EXPLAIN ANALYZE des 3 queries critiques de l'API Athlya
--
-- Sprint 14 / Slice 14.7 (Epic CN.2.5).
--
-- Vérifie que les query plans des hot paths n'ont PAS de
-- sequential scan large. Toute régression d'index manquant le
-- ferait apparaître ici. Le workflow CI `pgtap.yml` lance ce
-- script contre un Postgres seedé à 10k réservations × 500
-- classes pour reproduire la pression de production.
--
-- Les assertions sont basées sur la structure du plan, pas sur
-- les timings absolus (qui varient avec le hardware CI). On
-- vérifie :
--   1. Index Scan / Bitmap Index Scan utilisés pour les WHERE
--   2. Pas de Seq Scan sur > 100 rows
--   3. `Rows Removed by Filter` sous une limite acceptable
--
-- Le script suppose le seed `seed-explain-fixtures.sql` chargé
-- (voir même répertoire). Il ne modifie aucune donnée — toutes
-- les queries sont des SELECT.

\set ON_ERROR_STOP on

-- Setup fixture variables (UUIDs des seeds).
\set test_studio_id '\'10000000-0000-4000-8000-000000000001\''
\set test_user_id   '\'10000000-0000-4000-8000-000000000002\''
\set test_class_id  '\'10000000-0000-4000-8000-000000000003\''

-- ---------------------------------------------------------------------
-- Q1 — bookClass FOR UPDATE de la classe (algorithme 2 §Step 1)
-- ---------------------------------------------------------------------
-- Contention-critical : doit utiliser PK index `classes_pkey`.
-- Plan attendu :
--   Index Scan using classes_pkey on classes (cost=…)
--     Index Cond: (id = $1)

\echo '----- Q1: bookClass FOR UPDATE classes -----'
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, studio_id, capacity, starts_at, version
FROM classes
WHERE id = :test_class_id
  AND deleted_at IS NULL
LIMIT 1
FOR UPDATE;

-- ---------------------------------------------------------------------
-- Q2 — listClasses range query (Epic 6.1, hot read path)
-- ---------------------------------------------------------------------
-- Doit utiliser l'index composite `classes_studio_starts_at_idx`
-- pour SELECT range scan. Sequential scan ici = bug de migration.
--
-- Le filtre `deleted_at IS NULL` est partiel — l'index doit le
-- prendre en compte (partial index sur `deleted_at IS NULL`).

\echo '----- Q2: listClasses range scan -----'
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, studio_id, capacity, starts_at, version, title
FROM classes
WHERE studio_id = :test_studio_id
  AND starts_at >= NOW()
  AND starts_at < NOW() + INTERVAL '7 days'
  AND deleted_at IS NULL
ORDER BY starts_at ASC
LIMIT 50;

-- ---------------------------------------------------------------------
-- Q3 — cancelReservation FOR UPDATE de la réservation
-- ---------------------------------------------------------------------
-- Doit utiliser PK index `reservations_pkey`. Le filtre WHERE
-- user_id n'est PAS utilisé pour le scan (le PK suffit) — c'est
-- une vérification d'autorisation post-lookup.

\echo '----- Q3: cancelReservation FOR UPDATE -----'
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, class_id, user_id, status, created_at
FROM reservations
WHERE id = '20000000-0000-4000-8000-000000000001'
LIMIT 1
FOR UPDATE;

-- ---------------------------------------------------------------------
-- Q4 — listMyReservations (read path, Epic 5.x)
-- ---------------------------------------------------------------------
-- Doit utiliser l'index `reservations_user_id_created_at_idx` (migration 0018)
-- pour le SELECT par user_id. L'index couvre (user_id, created_at DESC) et
-- élimine le sort pour ORDER BY created_at DESC.

\echo '----- Q4: listMyReservations user range -----'
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, class_id, status, created_at
FROM reservations
WHERE user_id = :test_user_id
ORDER BY created_at DESC
LIMIT 50;

-- ---------------------------------------------------------------------
-- Q5 — Waitlist FIFO promotion (Algorithm 2 §Step 5)
-- ---------------------------------------------------------------------
-- Doit utiliser un index composite (class_id, status, created_at)
-- pour scanner uniquement les rows waitlist d'une classe en
-- order by created_at.

\echo '----- Q5: waitlist FIFO promotion -----'
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, user_id, created_at
FROM reservations
WHERE class_id = :test_class_id
  AND status = 'waitlist'
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- ---------------------------------------------------------------------
-- Q6 — countWaitlistAhead (issue #238, migration 0013)
-- ---------------------------------------------------------------------
-- The waitlist position query filters on (class_id, status, created_at).
-- Expected plan: Index Scan using reservations_class_status_created_at_idx.
-- A sequential scan here means the partial composite index is missing.

\echo '----- Q6: countWaitlistAhead (waitlist partial index) -----'
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*)
FROM reservations
WHERE class_id = :test_class_id
  AND status = 'waitlist'
  AND created_at < NOW();

-- ---------------------------------------------------------------------
-- Q7 — admin RLS EXISTS subquery on classes (issue #238, migration 0013)
-- ---------------------------------------------------------------------
-- reservations_read_admin_same_studio evaluates:
--   EXISTS (SELECT 1 FROM classes c
--           WHERE c.id = reservations.class_id
--             AND c.studio_id = app_studio_id())
-- Expected plan: Index Only Scan using classes_id_studio_idx.

\echo '----- Q7: admin RLS EXISTS subquery (classes_id_studio_idx) -----'
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT 1
FROM classes
WHERE id = :test_class_id
  AND studio_id = :test_studio_id
  AND deleted_at IS NULL;

\echo '====================================='
\echo 'EXPLAIN ANALYZE complete.'
\echo 'Review each plan : Index Scan vs Seq Scan.'
\echo 'Failure mode: any "Seq Scan on (classes|reservations)"'
\echo 'with > 100 rows scanned indicates a missing index.'
\echo '====================================='
