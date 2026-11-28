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
 *   - `brand_logo_light` / `brand_logo_dark` hold an https URL or a capped
 *     `data:image/*` URL (migration 0053, CHECK constraints there).
 *   - `hide_athlya_branding` drops the "via Athlya" footer of the studio's
 *     transactional e-mails.
 *
 * Related requirements: 6.1 (studio binding), 13.2 (tenant isolation).
 */

import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, uuidPrimaryKey } from './_shared.js';

export const studios = pgTable(
  'studios',
  {
    id: uuidPrimaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    brandColor: text('brand_color').notNull().default('#0EA5E9'),
    brandLogoLight: text('brand_logo_light'),
    brandLogoDark: text('brand_logo_dark'),
    hideAthlyaBranding: boolean('hide_athlya_branding').notNull().default(false),
    /** Settings of migration 0055 (issue #759). `timezone` is an IANA name. */
    timezone: text('timezone').notNull().default('Europe/Paris'),
    addressLine: text('address_line'),
    postalCode: text('postal_code'),
    city: text('city'),
    /** ISO 3166-1 alpha-2. */
    country: text('country'),
    /** `citext` in the database. */
    contactEmail: text('contact_email'),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex('studios_slug_unique').on(table.slug)],
);

export type StudioRow = typeof studios.$inferSelect;
export type StudioInsert = typeof studios.$inferInsert;
