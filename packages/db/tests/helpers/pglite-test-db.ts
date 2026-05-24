import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../../src/schema/index.js';

import type { AthlyaSchema } from '../../src/client.js';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

export type PgliteAthlyaDb = PgliteDatabase<AthlyaSchema>;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', '..', 'migrations');

export function readPgliteMigration(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
}

export interface PgliteTestHandle {
  readonly pglite: PGlite;
  readonly db: PgliteAthlyaDb;
  teardown(): Promise<void>;
}

/**
 * Spins up an in-memory PGlite instance, applies the requested
 * migrations in order, and wraps the result in a Drizzle handle.
 *
 * PGlite's exec() accepts multi-statement SQL natively; the
 * -->  statement-breakpoint markers emitted by drizzle-kit are SQL
 * line-comments and are ignored by the PostgreSQL parser.
 *
 * CN.9.3 - local test fallback (no Docker required).
 */
export async function createPgliteTestDb(migrationNames: string[]): Promise<PgliteTestHandle> {
  const pglite = new PGlite();

  for (const name of migrationNames) {
    await pglite.exec(readPgliteMigration(name));
  }

  const db = drizzle(pglite, { schema });

  return {
    pglite,
    db,
    teardown: () => pglite.close(),
  };
}
