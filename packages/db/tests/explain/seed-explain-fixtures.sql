-- Seed dataset pour les EXPLAIN ANALYZE de production-réaliste.
--
-- Sprint 14 / Slice 14.7 (Epic CN.2.5).
--
-- Cible : 500 classes × 10000 réservations.
-- Distribution :
--   - 1 studio principal (le test_studio_id)
--   - 200 users (pour avoir une distribution non-triviale)
--   - 500 classes étalées sur 30 jours
--   - 10000 réservations (mélange confirmed + waitlist + cancelled)
--
-- Le dataset est suffisamment grand pour que :
--   - L'optimiseur Postgres choisisse un plan REALISTE (vs 1-row
--     micro-benchmark où il sequential-scan toujours)
--   - Les index manqués apparaissent comme du Seq Scan
--   - Les ANALYZE timings soient stables (variance < 10%)
--
-- Lancement :
--   psql $DATABASE_URL -f seed-explain-fixtures.sql
--   psql $DATABASE_URL -f explain-critical-queries.sql
--
-- Cleanup : `TRUNCATE TABLE reservations, classes, users RESTART IDENTITY CASCADE`

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------
-- Studio + users
-- ---------------------------------------------------------------------

INSERT INTO studios (id, slug, name)
VALUES ('10000000-0000-4000-8000-000000000001', 'explain-test-studio', 'Explain Test Studio')
ON CONFLICT (id) DO NOTHING;

-- 200 users — UUIDs déterministes pour idempotence du seed.
INSERT INTO users (id, studio_id, email, display_name, consents, role)
SELECT
    ('10000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
    '10000000-0000-4000-8000-000000000001',
    'user-' || gs || '@explain-test.invalid',
    'User ' || gs,
    '{"marketing":false,"analytics":false,"thirdParty":false,"version":"2026-01","updatedAt":"2026-01-01T00:00:00.000Z"}'::jsonb,
    'member'
FROM generate_series(1, 200) AS gs
ON CONFLICT (id) DO NOTHING;

-- Le user "principal" pour la query Q4 (listMyReservations).
-- ID stable, on s'assure qu'il existe.
INSERT INTO users (id, studio_id, email, display_name, consents, role)
VALUES (
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'principal@explain-test.invalid',
    'Principal User',
    '{"marketing":false,"analytics":false,"thirdParty":false,"version":"2026-01","updatedAt":"2026-01-01T00:00:00.000Z"}'::jsonb,
    'member'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Classes — 500 étalées sur les 30 prochains jours
-- ---------------------------------------------------------------------
-- Distribution : ~16 cours par jour pendant 30 jours.

INSERT INTO classes (id, studio_id, title, capacity, starts_at, duration_min, version)
SELECT
    ('10000000-0000-4000-8000-' || lpad((gs + 1000)::text, 12, '0'))::uuid,
    '10000000-0000-4000-8000-000000000001',
    'Explain test class #' || gs,
    20,
    NOW() + (gs || ' minutes')::interval * 90,  -- ~1 cours / 90 min
    60,
    1
FROM generate_series(1, 500) AS gs
ON CONFLICT (id) DO NOTHING;

-- Class "principale" pour Q1+Q5 — avec 50 waitlist pour exercer
-- la query waitlist FIFO.
INSERT INTO classes (id, studio_id, title, capacity, starts_at, duration_min, version)
VALUES (
    '10000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'Principal explain test class',
    20,
    NOW() + INTERVAL '2 hours',
    60,
    1
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Réservations — 10000 distribuées
-- ---------------------------------------------------------------------
-- 80% confirmed, 15% waitlist, 5% cancelled.
-- Spread sur les 500 classes + 200 users.

INSERT INTO reservations (id, class_id, user_id, status, created_at)
SELECT
    ('20000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
    ('10000000-0000-4000-8000-' || lpad(((gs % 500) + 1001)::text, 12, '0'))::uuid,
    ('10000000-0000-4000-8000-' || lpad(((gs % 200) + 1)::text, 12, '0'))::uuid,
    CASE
        WHEN gs % 100 < 80 THEN 'confirmed'
        WHEN gs % 100 < 95 THEN 'waitlist'
        ELSE 'cancelled'
    END::reservation_status,
    NOW() - (gs || ' minutes')::interval * 5
FROM generate_series(1, 10000) AS gs
ON CONFLICT DO NOTHING;

-- 50 réservations waitlist sur la class principale (Q5).
INSERT INTO reservations (id, class_id, user_id, status, created_at)
SELECT
    ('30000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
    '10000000-0000-4000-8000-000000000003',
    ('10000000-0000-4000-8000-' || lpad(((gs % 200) + 1)::text, 12, '0'))::uuid,
    'waitlist'::reservation_status,
    NOW() - (gs || ' minutes')::interval * 2
FROM generate_series(1, 50) AS gs
ON CONFLICT DO NOTHING;

-- 100 réservations confirmed pour le user principal (Q4).
INSERT INTO reservations (id, class_id, user_id, status, created_at)
SELECT
    ('40000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
    ('10000000-0000-4000-8000-' || lpad(((gs % 500) + 1001)::text, 12, '0'))::uuid,
    '10000000-0000-4000-8000-000000000002',
    'confirmed'::reservation_status,
    NOW() - (gs || ' hours')::interval * 1
FROM generate_series(1, 100) AS gs
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- ANALYZE pour mettre à jour les stats du planner
-- ---------------------------------------------------------------------
-- Sans ANALYZE après un seed massif, l'optimiseur a des stats
-- périmées et choisit des plans aberrants. Ce step est crucial.

ANALYZE classes;
ANALYZE reservations;
ANALYZE users;

COMMIT;

\echo 'Seed complete:'
\echo '  - 200 users + 1 principal'
\echo '  - 500 classes + 1 principal'
\echo '  - 10000 reservations + 50 waitlist principal + 100 user principal'
