/**
 * Versioned consent record attached to every User.
 *
 * Consents are stored in a single JSONB column with an explicit `version`
 * identifier (matching the CGU / privacy-policy revision the user accepted)
 * and an `updatedAt` timestamp. Any future change to the legal text bumps
 * `version`, which in turn triggers the "re-consent" UX.
 *
 * Related requirements:
 *   - Requirement 3.1 (profile payload includes current consents).
 *   - Requirement 3.3 (consent updates replace the full record, stamp
 *     `updatedAt`, bind to the current CGU version).
 *   - Requirement 17.1 (Notifications service reads consents before
 *     delivering marketing / analytics messages).
 */

import { z } from 'zod';

import { IsoDateTimeSchema } from './primitives.js';

/**
 * CGU / privacy-policy version identifier. Shape `YYYY-MM` so that new
 * monthly revisions sort lexicographically and compare as plain strings.
 */
export const ConsentsVersionSchema = z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'must be a YYYY-MM CGU version identifier');

/**
 * Full consents record as persisted on `users.consents` and returned by
 * `GET /v1/members/me`. Strict so unknown flags from an older client never
 * silently roll back recently-added consent categories.
 */
export const ConsentsSchema = z
    .object({
        marketing: z.boolean(),
        analytics: z.boolean(),
        thirdParty: z.boolean(),
        version: ConsentsVersionSchema,
        updatedAt: IsoDateTimeSchema,
    })
    .strict();

export type Consents = z.infer<typeof ConsentsSchema>;
export type ConsentsVersion = z.infer<typeof ConsentsVersionSchema>;
