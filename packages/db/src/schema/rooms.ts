/**
 * `rooms`: the places of a studio where classes run (migration 0051,
 * issue #748).
 *
 *   - `capacity` is optional: a hint the planning offers as the default
 *     capacity of a class booked in the room, never a booking limit.
 *   - Rooms are soft-deleted (`deleted_at`); a live name is unique per
 *     studio regardless of case (`rooms_studio_name_live_unique`).
 *   - The composite `(id, studio_id)` key is what `classes.room_id`
 *     references, so a class can only run in a room of its own studio.
 *
 * RLS (0051): every role of the studio reads its rooms, only an admin
 * creates or updates one.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, uuidPrimaryKey } from './_shared.js';
import { studios } from './studios.js';

export const rooms = pgTable(
  'rooms',
  {
    id: uuidPrimaryKey(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    capacity: integer('capacity'),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('rooms_id_studio_unique').on(table.id, table.studioId),
    uniqueIndex('rooms_studio_name_live_unique')
      .on(table.studioId, sql`lower(${table.name})`)
      .where(sql`deleted_at IS NULL`),
    check('rooms_name_length', sql`char_length(btrim(${table.name})) BETWEEN 1 AND 80`),
    check(
      'rooms_capacity_range',
      sql`${table.capacity} IS NULL OR ${table.capacity} BETWEEN 1 AND 500`,
    ),
  ],
);

export type RoomRow = typeof rooms.$inferSelect;
export type RoomInsert = typeof rooms.$inferInsert;
