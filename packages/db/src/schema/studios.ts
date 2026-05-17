/**
 * `studios` — tenant root table.
 *
 * Every other row in the Athlya database is scoped to exactly one studio
 * via a foreign key. The `slug` column is the URL-safe identifier surfaced
 * to members (`/register?studio=athlya-lyon`).
 *
 * Column choices:
 *   - `slug` uses plain `text` with a `UNIQUE` index; we do not use
 *     `citext` here because slugs are constrained to lowercase by the
 *     shared Zod schema `SlugSchema`. `users.email` is the column that
 *     warrants `citext` (task 2.2 enables the extension).
 *   - `brand_color` defaults to Athlya's brand blue — a studio that never
 *     customises its theme still reads a correct value.
 *
 * Related requirements: 6.1 (studio binding), 13.2 (tenant isolation).
 */

import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, uuidPrimaryKey } from './_shared.js';

export const studios = pgTable(
  'studios',
  {
    id: uuidPrimaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    brandColor: text('brand_color').notNull().default('#0EA5E9'),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex('studios_slug_unique').on(table.slug)],
);

export type StudioRow = typeof studios.$inferSelect;
export type StudioInsert = typeof studios.$inferInsert;
