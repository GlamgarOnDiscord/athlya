/**
 * Codec for the {@link AuditLog} domain model plus the two bigint ↔
 * string helpers that translate between the PostgreSQL `BIGSERIAL`
 * primary key used by the DB layer and the JSON-safe string used
 * everywhere else.
 *
 * ## BigInt handling contract
 *
 * PostgreSQL `BIGSERIAL` is a 64-bit signed integer. JSON numbers are
 * IEEE-754 doubles that can only represent integers up to
 * `Number.MAX_SAFE_INTEGER = 2^53 − 1 ≈ 9.007 × 10^15`. A busy studio
 * will cross that threshold eventually, so the wire format for
 * `AuditLog.id` is ALWAYS a string. The codec surface therefore
 * exposes:
 *
 *   - {@link bigintToId} (`bigint → string`) used by the DB layer when
 *     it reads rows out of Postgres.
 *   - {@link idToBigint} (`string → bigint`) used by the DB layer when
 *     it needs to pass an id back through a typed driver.
 *   - {@link AuditLogCodec.toJSON} / {@link AuditLogCodec.fromJSON},
 *     which operate on `AuditLog` values that already carry a `string`
 *     id — the bigint translation happens outside the codec.
 *
 * These helpers live here (rather than in `packages/db`) so that the
 * entire bigint ↔ string rule has a single source of truth. The codec
 * layer is the only place in the codebase that should materialise a
 * bigint.
 *
 * ## Metadata
 *
 * `metadata` is a free-form `Record<string, unknown>`. The codec passes
 * it through unchanged: introspection, PII stripping and versioning of
 * metadata shapes are the responsibility of the member-service
 * anonymisation job (Requirement 5.3), not this layer.
 *
 * Round-trip guarantee (Requirement 21.3):
 *   `AuditLogCodec.fromJSON(AuditLogCodec.toJSON(x))` is structurally
 *   equal to `x` for every valid `AuditLog` value `x`.
 */

import { AuditLogSchema, type AuditLog } from '../schemas/domain.js';

import type { AuditLogWire } from './types.js';

/* ------------------------------------------------------------------ */
/*  BigInt helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Convert a database-native `bigint` id into the JSON-safe string used
 * by every wire representation. Identity-like for small ids; crucial
 * beyond `Number.MAX_SAFE_INTEGER`.
 */
export function bigintToId(n: bigint): string {
    return String(n);
}

/**
 * Convert a wire id back into a `bigint`. Throws a {@link SyntaxError}
 * when the input is not a valid bigint literal (whitespace, non-digit
 * characters, empty string, floating-point, …) so that callers can
 * distinguish "malformed id" from a genuine domain error.
 *
 * Using a narrow `SyntaxError` — rather than letting the native
 * `BigInt` constructor throw its own `SyntaxError` with an inscrutable
 * message — gives the API gateway a stable `code` to translate into a
 * Problem Details response.
 */
export function idToBigint(id: string): bigint {
    try {
        return BigInt(id);
    } catch {
        throw new SyntaxError('invalid AuditLog.id (not a bigint)');
    }
}

/* ------------------------------------------------------------------ */
/*  AuditLog codec                                                     */
/* ------------------------------------------------------------------ */

function toJSON(value: AuditLog): AuditLogWire {
    return {
        id: value.id,
        actorId: value.actorId,
        action: value.action,
        targetType: value.targetType,
        targetId: value.targetId,
        // Pass metadata through unchanged — see the module-level JSDoc.
        metadata: value.metadata,
        createdAt: value.createdAt,
    };
}

function fromJSON(raw: unknown): AuditLog {
    return AuditLogSchema.parse(raw);
}

export const AuditLogCodec = {
    toJSON,
    fromJSON,
} as const;
