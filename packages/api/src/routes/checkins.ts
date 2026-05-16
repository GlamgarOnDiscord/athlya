/**
 * `/v1/checkins/*` domain router — task 8.11.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path | Chain                                                                |
 *   |--------|------|----------------------------------------------------------------------|
 *   | POST   | /    | jwtAuth → projectUserId → zValidator(CheckInRequestSchema) → idempotency → handler |
 *
 * Requirements:
 *   • 11.1–11.6 — the QR token is verified by the service (via
 *                 `verifyAccessQR` from `@athlya/auth/qr`) before the
 *                 reservation lookup runs. Each failure code is mapped
 *                 to a specific 401 body so the UI can surface
 *                 actionable diagnostics (`invalid_signature`,
 *                 `token_expired`, `replay`, `wrong_studio`,
 *                 `wrong_kind`, `malformed`).
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency.
 *
 * Although the QR payload is a JWT in its own right, the request
 * itself must still be authenticated via the member's session JWT —
 * the QR token is the credential for *this specific check-in*, not
 * for the whole API surface.
 */

import { CheckInRequestSchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { idempotency, projectUserIdFromClaims, readValidated, traceOperation } from './helpers.js';

import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { CheckInRequest } from '@athlya/shared/schemas/api';
import type { Context } from 'hono';


/* ------------------------------------------------------------------ */
/*  Outcome                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fine-grained failure reasons surfaced by the check-in service.
 * Matches `QRVerifyFailReason` from
 * `@athlya/reservations/checkin` plus the two post-verification
 * failure modes (`outside_window`, `no_reservation`).
 */
export type CheckInFailReason =
    | 'invalid_signature'
    | 'token_expired'
    | 'replay'
    | 'wrong_studio'
    | 'wrong_kind'
    | 'malformed'
    | 'outside_window'
    | 'no_reservation';

/** Discriminated result returned by {@link CheckinsDeps.checkIn}. */
export type CheckInOutcome =
    | { readonly kind: 'success'; readonly reservation: unknown; readonly member: unknown }
    | { readonly kind: 'fail'; readonly reason: CheckInFailReason };

/** Dependencies injected into {@link buildCheckinsRouter}. */
export interface CheckinsDeps {
    checkIn(
        studioId: string,
        input: CheckInRequest,
    ): Promise<CheckInOutcome>;

    readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Problem Details                                                    */
/* ------------------------------------------------------------------ */

/**
 * Reasons that surface as HTTP 401 per Requirement 11.3. Everything
 * else (`outside_window`, `no_reservation`) surfaces as 422 because
 * the token itself was valid but the state machine rejected the
 * check-in.
 */
const TOKEN_FAILURE_REASONS = new Set<CheckInFailReason>([
    'invalid_signature',
    'token_expired',
    'replay',
    'wrong_studio',
    'wrong_kind',
    'malformed',
]);

function problemCheckinFail(
    c: Context<HonoEnv>,
    reason: CheckInFailReason,
): Response {
    const status: 401 | 422 = TOKEN_FAILURE_REASONS.has(reason) ? 401 : 422;
    const title = status === 401 ? 'Unauthorized' : 'Unprocessable Entity';
    return c.body(
        JSON.stringify({
            type: 'about:blank',
            title,
            status,
            detail: `check-in rejected: ${reason}`,
            code: reason,
            traceId: c.get('traceId'),
        }),
        status,
        { 'content-type': 'application/problem+json' },
    );
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/checkins/*` sub-router. */
export function buildCheckinsRouter(deps: CheckinsDeps): Hono<HonoEnv> {
    const router = new Hono<HonoEnv>();
    const idem = deps.idempotency;

    router.use('*', jwtAuth());

    // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
    router.use(
        '*',
        studioRateLimit() as Parameters<typeof router.use>[1],
    );

    router.post(
        '/',
        projectUserIdFromClaims(),
        zValidator('json', CheckInRequestSchema),
        ...(idem ? [idempotency(idem)] : []),
        async (c) => {
            traceOperation(c, 'checkins.check-in');
            const claims = c.get('authClaims');
            if (claims === undefined) {
                throw new Error(
                    'authClaims unexpectedly missing after jwtAuth',
                );
            }
            const body = readValidated<CheckInRequest>(c, 'json');
            const outcome = await deps.checkIn(claims.studioId, body);

            if (outcome.kind === 'success') {
                return c.json(
                    {
                        success: true,
                        reservation: outcome.reservation,
                        member: outcome.member,
                    },
                    200,
                );
            }
            return problemCheckinFail(c, outcome.reason);
        },
    );

    return router;
}
