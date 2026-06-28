-- =====================================================================
-- Athlya Platform — UUID v7 primary-key defaults (0016)
--
-- Issue #232.
--
-- Adds a pure-SQL gen_uuid_v7() function and updates the DEFAULT
-- expression on every UUID-pk table so new rows get time-ordered
-- (monotonically increasing) identifiers instead of random UUID v4.
--
-- Design choices:
--   - gen_uuid_v7() is implemented in pure SQL (no extension) so it
--     works on Neon PostgreSQL 17 without any account-level extension
--     provisioning. It embeds a 48-bit Unix-ms timestamp in the leading
--     bytes and sets version=7 / variant=10 bits per RFC 9562 §5.7.
--   - Only the column DEFAULT is changed; existing rows keep their UUID
--     v4 values. UUID is an opaque type to the application layer, so
--     mixing v4 and v7 rows in the same table is safe.
--   - audit_log uses a BIGSERIAL primary key — excluded from this
--     migration; the monotonicity property is already guaranteed there.
--   - All nine tables that previously defaulted to gen_random_uuid() are
--     updated in one migration to keep the DB schema in sync with the
--     Drizzle schema change in packages/db/src/schema/_shared.ts.
--
-- Keyset pagination note (issue #334):
--   Existing rows keep v4 UUIDs. Any paginated endpoint that uses
--   `ORDER BY id` as the sole cursor key will produce inconsistent pages
--   because v4 UUIDs sort lexicographically relative to v7 UUIDs in an
--   unpredictable order. All cursor-paginated queries must use a stable
--   timestamp column as the primary sort key (e.g. `created_at` or
--   `starts_at`) and treat `id` only as a tie-breaker. The tie-breaking
--   order within a single timestamp bucket may mix v4 and v7 values, but
--   the `(timestamp, id)` pair remains a unique, stable sort key so
--   pagination is always correct and gap-free.
-- =====================================================================

-- UUID v7 generator (RFC 9562 §5.7).
-- Encodes a 48-bit Unix-ms timestamp into the first 6 bytes of a UUID,
-- sets version bits (4-bit field = 0111), and sets the RFC 4122 variant
-- bits (bits 64–65 = 10). The remaining 74 bits are random (from
-- gen_random_uuid()), matching the spec's "rand_a" and "rand_b" fields.
CREATE OR REPLACE FUNCTION gen_uuid_v7() RETURNS uuid
LANGUAGE sql AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid()) PLACING
          substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;

-- Switch DEFAULT on every UUID-pk table.
ALTER TABLE "classes"                ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "export_jobs"            ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "outbox"                 ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "password_reset_tokens"  ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "push_tokens"            ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "reservations"           ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "studios"                ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "users"                  ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
ALTER TABLE "workout_sessions"       ALTER COLUMN "id" SET DEFAULT gen_uuid_v7();
