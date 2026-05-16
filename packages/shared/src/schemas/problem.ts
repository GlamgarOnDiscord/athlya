/**
 * RFC 7807 "Problem Details for HTTP APIs" schema.
 *
 * Every error response returned by the Athlya API is serialised as
 * `application/problem+json` using this shape. The `traceId` field
 * threads the W3C `traceparent` value through to the client so support
 * tickets can be correlated with OpenTelemetry traces in Axiom.
 *
 * Related requirements:
 *   - Requirement 14.2 (shared Zod validation of every request / response).
 *   - Requirement 14.6 (Problem Details envelope with `type`, `title`,
 *     `status`, `traceId`).
 *
 * Reference: {@link https://datatracker.ietf.org/doc/html/rfc7807 RFC 7807}.
 */

import { z } from 'zod';

/**
 * One field-level validation error, produced by request-schema parse
 * failures. `path` follows the dotted JSON-pointer-ish convention used by
 * Zod (e.g. `exercises.2.sets.0.reps`).
 */
export const ProblemFieldErrorSchema = z
    .object({
        path: z.string(),
        message: z.string(),
    })
    .strict();

export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;

/**
 * Problem Details envelope. `type` defaults to `about:blank` per RFC 7807
 * when the server has nothing more specific. `code` is an Athlya-specific
 * machine-readable identifier (`class_in_past`, `range_too_large`, …)
 * referenced throughout the requirements document so clients can switch on
 * it without parsing `detail`.
 */
export const ProblemDetailsSchema = z
    .object({
        type: z.url().default('about:blank'),
        title: z.string(),
        status: z.number().int().min(100).max(599),
        detail: z.string().optional(),
        instance: z.string().optional(),
        traceId: z.string().optional(),
        code: z.string().optional(),
        errors: z.array(ProblemFieldErrorSchema).optional(),
    })
    .strict();

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
