/**
 * Drizzle Kit configuration for the Athlya database package.
 *
 * Responsibilities:
 *   - Point drizzle-kit at the Drizzle schema barrel so `drizzle-kit
 *     generate` can diff the TypeScript schema against the current
 *     migrations folder and emit a new SQL file.
 *   - Target PostgreSQL 17 on Neon.
 *   - Read the connection string from `DATABASE_URL` — this is only
 *     needed for `drizzle-kit push` / `migrate`. `generate` works purely
 *     from the schema and the `./migrations` folder, so no live database
 *     is required at generation time.
 *
 * Related task: 2.2 (initial migration generation).
 */

import { defineConfig } from 'drizzle-kit';

/**
 * `DATABASE_URL` is intentionally optional for `generate` and `studio`.
 * Production runs feed a real Neon connection string via environment
 * variables; CI generation jobs can leave it unset.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
