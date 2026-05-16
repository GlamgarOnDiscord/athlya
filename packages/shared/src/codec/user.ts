/**
 * Codec for the {@link User} domain model and the {@link Consents}
 * sub-record attached to it.
 *
 * ## Consents versioning
 *
 * The codec preserves `consents.version` verbatim. A `version` of
 * `"2026-01"` that arrives over the wire flows through unchanged to
 * the domain value, and vice-versa. The codec layer performs NO
 * migration, NO upgrade, NO "fill missing fields" logic — those
 * responsibilities live in `packages/members` alongside the rest of
 * the consent-lifecycle rules (Requirement 3.3).
 *
 * This separation matters because the codec is called on both sides
 * of the wire. Migrating versions inside `toJSON` / `fromJSON` would
 * silently rewrite legally-signed consent records, breaking the
 * audit trail (Requirement 22.1) and weakening the RGPD guarantees.
 *
 * Round-trip guarantee (Requirement 21.3):
 *   `UserCodec.fromJSON(UserCodec.toJSON(x))` is structurally equal
 *   to `x` for every valid `User` value `x`. Same for `ConsentsCodec`.
 */

import { ConsentsSchema, type Consents } from '../schemas/consents.js';
import { UserSchema, type User } from '../schemas/domain.js';

import type { ConsentsWire, UserWire } from './types.js';

/* ------------------------------------------------------------------ */
/*  Consents                                                           */
/* ------------------------------------------------------------------ */

function consentsToJSON(value: Consents): ConsentsWire {
    return {
        marketing: value.marketing,
        analytics: value.analytics,
        thirdParty: value.thirdParty,
        // Preserve `version` byte-for-byte. See the module-level JSDoc.
        version: value.version,
        updatedAt: value.updatedAt,
    };
}

function consentsFromJSON(raw: unknown): Consents {
    return ConsentsSchema.parse(raw);
}

export const ConsentsCodec = {
    toJSON: consentsToJSON,
    fromJSON: consentsFromJSON,
} as const;

/* ------------------------------------------------------------------ */
/*  User                                                               */
/* ------------------------------------------------------------------ */

function toJSON(value: User): UserWire {
    return {
        id: value.id,
        studioId: value.studioId,
        email: value.email,
        displayName: value.displayName,
        avatarUrl: value.avatarUrl,
        role: value.role,
        consents: consentsToJSON(value.consents),
        createdAt: value.createdAt,
        deletedAt: value.deletedAt,
    };
}

function fromJSON(raw: unknown): User {
    return UserSchema.parse(raw);
}

export const UserCodec = {
    toJSON,
    fromJSON,
} as const;
