/**
 * Members service — versioned consents update use case.
 *
 * Implements task 5.2 of the Athlya implementation plan. The single
 * use case exposed by this module is:
 *
 *   - {@link updateConsents} — replace the `consents` JSON value on a
 *     user row with `{ ...input, version: CURRENT_CGU_VERSION,
 *     updatedAt: now() }` and append a matching `user.consents.updated`
 *     entry to the immutable audit log (Requirements 3.3, 22.1).
 *
 * Validation is delegated entirely to `ConsentsInputSchema` from
 * `@athlya/shared/schemas/api`, so the rules enforced here are
 * bit-for-bit identical to what the web and mobile clients enforce at
 * the edge: exactly the three boolean flags (`marketing`, `analytics`,
 * `thirdParty`), rejected on any unknown field thanks to `.strict()`.
 * The CGU `version` and `updatedAt` timestamp are stamped server-side
 * (Requirement 3.3) — clients never get to pick either.
 *
 * The audit append is best-effort from the caller's point of view: a
 * failure to write the audit row MUST NOT mask a successful consents
 * update, because the compliance invariant only cares that the record
 * eventually lands in the database. The failure is logged at `warn`
 * level so operators can investigate and replay from the stored
 * consents row if needed.
 *
 * Framework-free by design: the module depends only on the two
 * pluggable ports {@link ConsentsRepo} and {@link AuditLogWriter}.
 * The concrete Drizzle-backed repo and the QStash-backed audit writer
 * are assembled by the API gateway (Epic 7) and are responsible for
 * running every call under `withTenant(claims, fn)` so RLS
 * (Requirement 13) is applied.
 */

import { ConsentsInputSchema } from '@athlya/shared/schemas/api';

import { MembersError } from './service.js';

import type { Consents } from '@athlya/shared/schemas';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Identifier of the CGU / privacy-policy revision currently in force.
 * Stamped on every consents record the service writes (Requirement
 * 3.3) so downstream consumers — notably the re-consent UX and the
 * Notifications_Service consent gate (Requirement 17.1) — can detect
 * outdated acceptance by plain lexicographic string comparison.
 *
 * The shape `YYYY-MM` is validated by `ConsentsVersionSchema`; bumping
 * this constant triggers the re-consent flow for every existing user.
 */
export const CURRENT_CGU_VERSION = '2026-01';

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Minimal contract the consents use case needs from the persistence
 * layer. Declared here (rather than in `@athlya/db`) so the service
 * owns its own port and so unit tests can provide a trivial
 * `vi.fn()` double without pulling Drizzle or Postgres into the test
 * runtime.
 *
 * `findConsents` returns `null` when the user row has no consents
 * value yet — for example immediately after a legacy import that
 * predates the versioned consents record. In that case the service
 * falls back to a synthetic "never accepted" record so the audit
 * trail still captures a `previousVersion` of `'0000-00'`.
 */
export interface ConsentsRepo {
    /** Return the current consents for `userId`, or `null` if unknown. */
    findConsents(userId: string): Promise<Consents | null>;

    /**
     * Replace the consents record for `userId` with `consents` and
     * return the stored row. The caller has already stamped
     * `consents.version` and `consents.updatedAt`; the repo must
     * simply persist and echo the record.
     */
    updateConsents(userId: string, consents: Consents): Promise<Consents>;
}

/* ------------------------------------------------------------------ */
/*  Audit log port                                                     */
/* ------------------------------------------------------------------ */

/**
 * Shape of a single row appended to the immutable `audit_log` table
 * (Requirement 22.1). Mirrors `AuditLogSchema` from
 * `@athlya/shared/schemas/domain`, minus the server-assigned `id` and
 * `createdAt` (those are filled in by the database / writer).
 *
 * `metadata` is intentionally open (`Record<string, unknown>`) because
 * it carries per-action context whose shape varies per `action` —
 * exactly the posture `AuditLogSchema` takes at the domain level.
 */
export interface AuditLogEntry {
    /** UserId of the actor that triggered the action; nullable post-anonymisation. */
    actorId: string;
    /** Dotted action identifier, e.g. `user.consents.updated`. */
    action: string;
    /** Domain tag for the target, e.g. `user`. */
    targetType: string;
    /** Identifier of the target within `targetType`. */
    targetId: string;
    /** Free-form JSON metadata — shape depends on `action`. */
    metadata: Record<string, unknown>;
}

/**
 * Minimal port for appending to the `audit_log` table. The production
 * implementation wraps a Drizzle insert under the same
 * `withTenant(claims, fn)` helper as the rest of the members service
 * so RLS is applied.
 */
export interface AuditLogWriter {
    append(entry: AuditLogEntry): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Service deps                                                       */
/* ------------------------------------------------------------------ */

/**
 * Dependencies injected into {@link updateConsents}. `now` is exposed
 * so tests can freeze the clock and assert the exact `updatedAt`
 * string stamped into the stored record; `logger` is exposed so the
 * fallback warning emitted when the audit append fails can be
 * asserted in tests without shadowing `console.warn` globally.
 */
export interface ConsentsServiceDeps {
    consentsRepo: ConsentsRepo;
    audit: AuditLogWriter;
    /** Defaults to `Date.now`. Supplied explicitly in tests. */
    now?: () => number;
    /** Defaults to a thin wrapper over `console.warn`. */
    logger?: {
        warn: (msg: string, extra?: Record<string, unknown>) => void;
    };
}

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

/**
 * Synthetic "never accepted" record used when the repo reports no
 * prior consents row. The shape matches `ConsentsSchema` so downstream
 * consumers that assume a fully-populated `Consents` value aren't
 * forced to special-case the first-ever update. The version
 * identifier `'0000-00'` is deliberately older than any real CGU
 * revision so lexicographic comparisons continue to report the
 * user as "behind" the current version until the update succeeds.
 */
const NEVER_ACCEPTED: Consents = {
    marketing: false,
    analytics: false,
    thirdParty: false,
    version: '0000-00',
    updatedAt: '1970-01-01T00:00:00.000Z',
};

/* ------------------------------------------------------------------ */
/*  Use case — update consents                                         */
/* ------------------------------------------------------------------ */

/**
 * Replace the consents record for `userId` with a fresh copy carrying
 * the current CGU `version` and a server-stamped `updatedAt`, then
 * append a `user.consents.updated` row to the audit log.
 *
 * The payload is validated with {@link ConsentsInputSchema} (strict —
 * exactly the three boolean flags, nothing else). Any schema
 * violation surfaces as a {@link MembersError} with
 * `code = 'validation_failed'`; the API gateway maps that to HTTP 422
 * with an `application/problem+json` body.
 *
 * Ordering guarantees:
 *
 *   1. `findConsents` is called first so the audit entry can record
 *      the `previousVersion`; a `null` return is treated as
 *      {@link NEVER_ACCEPTED}.
 *   2. `updateConsents` is called second; if it throws, the audit
 *      append is skipped (there is nothing to audit) and the error
 *      propagates unchanged.
 *   3. `audit.append` is called last; a failure here is logged at
 *      `warn` level but does NOT mask the successful consents update,
 *      because the user-visible invariant is that their consents
 *      record was persisted. Operators can replay the audit append
 *      from the stored `updatedAt`.
 *
 * Requirements: 3.3, 22.1.
 */
export async function updateConsents(
    userId: string,
    input: unknown,
    deps: ConsentsServiceDeps,
): Promise<Consents> {
    const parsed = ConsentsInputSchema.safeParse(input);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            code: issue.code,
            message: issue.message,
        }));
        throw new MembersError(
            'validation_failed',
            `invalid consents: ${issues
                .map((i) => `${i.path || '<root>'} ${i.message}`)
                .join('; ')}`,
            issues,
        );
    }

    const previous =
        (await deps.consentsRepo.findConsents(userId)) ?? NEVER_ACCEPTED;

    const nowFn = deps.now ?? Date.now;
    const next: Consents = {
        ...parsed.data,
        version: CURRENT_CGU_VERSION,
        updatedAt: new Date(nowFn()).toISOString(),
    };

    const stored = await deps.consentsRepo.updateConsents(userId, next);

    // Audit append failure MUST NOT mask a successful consents update,
    // but the failure must be observable in logs for compliance audits.
    try {
        await deps.audit.append({
            actorId: userId,
            action: 'user.consents.updated',
            targetType: 'user',
            targetId: userId,
            metadata: {
                previousVersion: previous.version,
                newVersion: stored.version,
                flags: {
                    marketing: stored.marketing,
                    analytics: stored.analytics,
                    thirdParty: stored.thirdParty,
                },
            },
        });
    } catch (err) {
        const logger = deps.logger ?? { warn: console.warn.bind(console) };
        logger.warn('audit append failed; consents still persisted', {
            userId,
            error:
                err instanceof Error
                    ? { name: err.name, message: err.message }
                    : String(err),
        });
    }

    return stored;
}


/* ------------------------------------------------------------------ */
/*  Re-consent gating — Sprint-4 SP4.2 (Vague 32, finding S5-013)      */
/* ------------------------------------------------------------------ */

/**
 * Sentinel version used by {@link needsConsentRefresh} when the user
 * has never recorded any consents (legacy account predating the
 * versioning, or first time landing on the consent screen). Treated
 * as strictly older than every real version so the re-consent flow
 * always triggers.
 */
export const NEVER_CONSENTED_VERSION = '0000-00';

/**
 * Pure check: does this user need to re-accept the CGU/consents?
 *
 * Sprint-4 Slice 4.2 (audit finding S5-013 [MEDIUM][PROD-RISK]) —
 * the audit flagged that nothing in the codebase forced a user to
 * re-confirm their consents when {@link CURRENT_CGU_VERSION} bumps.
 * RGPD Art 7§1 requires the controller to be able to demonstrate
 * that the data subject has consented to the CURRENT version of the
 * processing terms; a user whose recorded version is stale has not
 * legally consented to anything that was added since.
 *
 * The function is intentionally pure and version-string-only — no
 * I/O, no auth context. Callers wire it into:
 *   - The web app's `<AuthContext>` after login: when this returns
 *     `true`, route to `/me/consents/refresh` before the app shell
 *     renders.
 *   - The API gateway's authenticated routes: optional, the audit
 *     log entry on `updateConsents` already captures the bump.
 *
 * Comparison strategy: `consents.version` is a string of the form
 * `'YYYY-MM'` (lexically sortable). A simple `<` comparison
 * against {@link CURRENT_CGU_VERSION} is sufficient as long as we
 * never use a non-zero-padded month — enforced by code review on
 * the constant itself.
 *
 * Returns `true` when the user MUST re-consent before continuing.
 */
export function needsConsentRefresh(
    userVersion: string | null | undefined,
): boolean {
    if (userVersion === null || userVersion === undefined || userVersion === '') {
        return true;
    }
    if (userVersion === NEVER_CONSENTED_VERSION) {
        return true;
    }
    return userVersion < CURRENT_CGU_VERSION;
}
