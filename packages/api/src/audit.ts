/**
 * `appendAudit` — thin, validated writer for the append-only
 * `audit_log` table.
 *
 * Purpose
 * -------
 * Requirements 22.1 and 22.2 together define a narrow contract: every
 * security-relevant action MUST produce one row carrying `actor_id`,
 * `action`, `target_type`, `target_id`, `metadata` and `created_at`,
 * and that row MUST survive inside the same transaction as the primary
 * state change so a rollback erases both together (no "ghost" audit
 * rows referring to events that never happened, no silent state
 * changes without an audit trail).
 *
 * This module does NOT:
 *   • Open or manage transactions — the caller owns the `tx`.
 *   • Issue SQL — a production {@link AuditLogStore} adapter does that
 *     in a later task (8.11 wires the Drizzle + `withTenant` backed
 *     store into the Hono gateway).
 *   • Enforce immutability — that is done by the database triggers
 *     `audit_log_forbid_update` / `audit_log_forbid_delete` defined in
 *     the migrations for task 2.2. The writer only INSERTs, so the
 *     triggers are invisible in the happy path.
 *
 * It DOES:
 *   • Validate every entry through a small zod schema so malformed
 *     audits (empty action slug, 10 kB target ids, …) fail fast at
 *     the call site rather than bloating the DB.
 *   • Delegate to a pluggable {@link AuditLogStore} port so the six
 *     wired call sites (see {@link AUDIT_ACTIONS}) can be unit-tested
 *     with a `vi.fn()` double without touching Postgres.
 *   • Propagate — never swallow — a store rejection. The caller's
 *     transaction must roll back on any failure of the audit insert;
 *     silently eating the error would violate Requirement 22.2 because
 *     the caller would commit the primary change with no audit row.
 *
 * Wired call sites (Requirement 22.1)
 * -----------------------------------
 * The six stable action slugs listed in {@link AUDIT_ACTIONS} are the
 * spec-mandated ones. The `action` field is typed as a closed union
 * branded with `string & {}`, so ad-hoc callers keep compile-time
 * autocomplete on the six canonical slugs while custom slugs (emitted
 * by a future feature before a spec update) remain assignable without
 * widening to plain `string`.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Maximum length of an action slug. Chosen to accommodate a fully
 * qualified domain-scoped slug (`billing.stripe.signature_failed` is
 * 31 chars) with generous headroom for future compound actions, while
 * staying small enough that a typo of the form `"x".repeat(10_000)`
 * bounces at the writer before it hits Postgres.
 */
const ACTION_MAX_LENGTH = 128;

/**
 * Maximum length of a target type tag. Target types are coarse
 * entity labels (`user`, `reservation`, `stripe_webhook`); 64 chars is
 * already ~10× the realistic maximum, sufficient to absorb any future
 * growth without being lax.
 */
const TARGET_TYPE_MAX_LENGTH = 64;

/**
 * Maximum length of a target identifier. UUIDs are 36 chars; opaque
 * Stripe identifiers (`evt_1PXhm…`) are at most ~40 chars; a few
 * internal stable IDs could be longer. 128 chars is the safe cap
 * before the column starts to receive free-form text that should
 * belong in `metadata` instead.
 */
const TARGET_ID_MAX_LENGTH = 128;

/**
 * The six action slugs wired in the MVP, kept as a readonly tuple so
 * grep can find every call site and a future audit can diff the set
 * against the list in Requirement 22.1.
 *
 * New call sites SHOULD reuse a slug from this list when they match
 * semantically, or add a new slug AND update this tuple plus the
 * {@link AuditAction} union below in the same commit.
 */
export const AUDIT_ACTIONS = [
    'user.registered',
    'user.deleted',
    'reservation.cancelled_by_admin',
    'rls.violation',
    'billing.stripe.signature_failed',
    'user.consents.updated',
] as const;

/**
 * Closed union of stable action slugs, with a `string & {}` escape
 * hatch so callers can pass a domain-specific slug without TypeScript
 * widening every literal in {@link AUDIT_ACTIONS} to plain `string`.
 *
 * Why the brand trick and not plain `string`?
 *   `'foo' | string` collapses to `string` in TypeScript, erasing the
 *   autocomplete on the six canonical slugs. Intersecting `string`
 *   with the empty object type `{}` keeps the union nominally distinct
 *   from the string literals, so IDE completions still surface them
 *   while custom slugs remain assignable.
 */
export type AuditAction =
    | (typeof AUDIT_ACTIONS)[number]
    | (string & {});

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * Structured audit record.
 *
 *   • `actorId`     UUID of the acting user, OR `null` for
 *                   unauthenticated actions (RLS violations from the
 *                   anon role, RGPD-anonymised rows — Req 5.3).
 *   • `action`      Stable slug identifying the action class; see
 *                   {@link AUDIT_ACTIONS}.
 *   • `targetType`  Coarse label describing what was acted on
 *                   (`user`, `reservation`, `stripe_webhook`, …).
 *                   Optional: some actions (e.g. `rls.violation` on
 *                   the list endpoint) do not have a single target.
 *   • `targetId`    Opaque stable identifier of the target. Treated
 *                   as text so the audit log keeps pointing at the
 *                   target even after the underlying row is deleted
 *                   (which is why the DB column has no FK either).
 *   • `metadata`    Free-form JSON context. Callers are responsible
 *                   for redacting PII at write time — the 30-day
 *                   anonymisation job (Req 5.3) can only clear fields
 *                   it knows about.
 */
export interface AuditEntry {
    readonly actorId: string | null;
    readonly action: AuditAction;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly metadata?: Record<string, unknown>;
}

/**
 * Port the writer delegates to. Production adapters (task 8.11) wrap
 * Drizzle `insert(auditLog)` inside a `withTenant` call so RLS sees
 * the correct studio_id; tests inject a `vi.fn()` double.
 *
 * `tx` is deliberately `unknown` so this package — which the Cloudflare
 * Worker edge bundle pulls in — stays free of a hard dependency on
 * Drizzle types. The gateway-layer wiring narrows the parameter back
 * to `AthlyaTx` in a single adapter file.
 */
export interface AuditLogStore {
    /**
     * Append `entry` to the audit log within the caller's transaction.
     *
     * MUST be a pure INSERT — UPDATE and DELETE are blocked by DB
     * triggers, so a misbehaving adapter will fail loud.
     * MUST NOT catch or transform validation errors; the writer has
     * already validated the entry.
     * MUST propagate I/O errors so the caller's transaction rolls back.
     */
    append(tx: unknown, entry: AuditEntry): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Zod schema for {@link AuditEntry}.
 *
 * Design choices:
 *   • `actorId` — nullable, no UUID shape check. Req 22.1 accepts any
 *     stable actor handle, and the DB column is still a `uuid` FK so
 *     malformed ids fail at the DB layer with a precise message. A
 *     redundant zod `.uuid()` would overlap and could drift.
 *   • `action`  — trimmed length check, not a regex. The set of legal
 *     slugs is open (`string & {}` union) so we only enforce the
 *     bounds called out in the task description.
 *   • `metadata` — `z.record(z.string(), z.unknown()).default({})`
 *     which fills the {} default when omitted.
 *
 * Throws `z.ZodError` on failure. Callers that need to distinguish
 * validation vs. I/O errors can `instanceof ZodError` / check
 * `err.name === 'ZodError'`.
 */
const AuditEntrySchema = z
    .object({
        actorId: z.string().nullable(),
        action: z
            .string()
            .min(1, 'action must be a non-empty string')
            .max(
                ACTION_MAX_LENGTH,
                `action must be ≤ ${String(ACTION_MAX_LENGTH)} characters`,
            ),
        targetType: z
            .string()
            .max(
                TARGET_TYPE_MAX_LENGTH,
                `targetType must be ≤ ${String(TARGET_TYPE_MAX_LENGTH)} characters`,
            )
            .optional(),
        targetId: z
            .string()
            .max(
                TARGET_ID_MAX_LENGTH,
                `targetId must be ≤ ${String(TARGET_ID_MAX_LENGTH)} characters`,
            )
            .optional(),
        metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict();

/* ------------------------------------------------------------------ */
/*  Writer                                                              */
/* ------------------------------------------------------------------ */

/**
 * Validate `entry` and append it to the audit log through `store`.
 *
 * Contract:
 *   • Validation runs FIRST via `AuditEntrySchema.parse`. A malformed
 *     entry throws `z.ZodError` before any I/O, so a caller that
 *     recovers from the error can still commit their transaction —
 *     no half-applied state.
 *   • On successful validation, the normalised entry (with
 *     `metadata` defaulted to `{}` when omitted) is forwarded verbatim
 *     to {@link AuditLogStore.append}. The writer does NOT re-wrap
 *     fields, inject a timestamp, or mutate `metadata`.
 *   • The promise returned by `store.append` is awaited and NEVER
 *     caught. Any rejection — DB unavailable, constraint violation,
 *     trigger refusal — propagates to the caller so the enclosing
 *     transaction rolls back and Req 22.2 (append-only, no orphan
 *     state) holds.
 *
 * @throws `z.ZodError`  when `entry` fails the schema check.
 * @throws whatever `store.append` rejects with, untouched.
 */
export async function appendAudit(
    tx: unknown,
    entry: AuditEntry,
    store: AuditLogStore,
): Promise<void> {
    // `parse` throws on failure; the caller decides what to do with
    // the error. We deliberately pass `entry` through the schema so
    // optional fields are preserved (not widened to `undefined`) and
    // the `metadata` default is applied.
    const normalised = AuditEntrySchema.parse(entry) as AuditEntry;
    await store.append(tx, normalised);
}
