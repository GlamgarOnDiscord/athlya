/**
 * Seed the local dev database with the minimum rows needed to
 * exercise the web register / login flow end-to-end.
 *
 * Inserts:
 *   - One demo studio (slug `athlya-demo`, brand colour default) if
 *     it does not already exist.
 *
 * Idempotent: re-running the script is safe. The studio insert uses
 * `ON CONFLICT (slug) DO NOTHING` so existing rows are preserved.
 *
 * Usage:
 *   $env:DATABASE_URL = 'postgresql://...'
 *   node packages/db/scripts/seed-dev.mjs
 */

import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1, prepare: false });
try {
  const [row] = await sql`
        INSERT INTO studios (slug, name, brand_color)
        VALUES ('athlya-demo', 'Athlya Demo Gym', '#0EA5E9')
        ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
        RETURNING id, slug, name
    `;
  console.log('[seed-dev] demo studio ready:', row);
} finally {
  await sql.end({ timeout: 2 });
}
