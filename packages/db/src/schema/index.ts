/**
 * Barrel export for the Drizzle schema.
 *
 * Consumers that need a single table import from here directly
 * (`import { classes } from '@athlya/db/schema'`). Migration generation
 * via `drizzle-kit` uses this barrel as the entry point so the whole
 * schema is visible in one pass.
 *
 * Each table module also exports `$inferSelect` / `$inferInsert` helpers
 * as `FooRow` / `FooInsert` — those flow through this barrel so the
 * repository and service layers can type their return values without
 * reaching into internal paths.
 */

export * from './enums.js';
export * from './studios.js';
export * from './users.js';
export * from './classes.js';
export * from './reservations.js';
export * from './workout_sessions.js';
export * from './audit_log.js';
export * from './outbox.js';
export * from './idempotency_keys.js';
export * from './push_tokens.js';
export * from './export_jobs.js';
export * from './password_reset_tokens.js';
