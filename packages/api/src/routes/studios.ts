/**
 * `/v1/studios/*` domain router — slice B9.1 + B9.2.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path | Chain                                                                       |
 *   |--------|------|-----------------------------------------------------------------------------|
 *   | GET    | /me  | jwtAuth → handler                                                           |
 *   | PATCH  | /me  | jwtAuth → requireRole('admin') → projectUserId → zValidator(body) → idem → handler |
 *
 * `GET /me` is open to every authenticated role (member / coach /
 * admin) — the front-end uses it to retrieve the brand color, slug
 * and display name without inferring them from the JWT. `PATCH /me`
 * is admin-only because it edits the tenant's branding surface.
 *
 * Validation flow on `PATCH /me`:
 *   1. Zod whitelists `name` / `brandColor` / `brandLogo` and rejects
 *      anything else with a 422 ValidationError envelope.
 *   2. The handler additionally enforces a WCAG 2.2 AA contrast check
 *      whenever `brandColor` changes — see slice B9.2 ACs. Failing
 *      colors return 422 with `code: 'brand_color_low_contrast'`.
 *
 * Requirements:
 *   • 13.2, 13.5 — every read / write is scoped to `claims.studioId`,
 *     never to a path or body parameter.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency.
 *   • 15.2 — server-side AA contrast gate.
 */

import { UpdateStudioRequestSchema } from '@athlya/shared/schemas/api';
import { evaluateBrandContrast } from '@athlya/shared/theming';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import {
    idempotency,
    projectUserIdFromClaims,
    readValidated,
    traceOperation,
    requireRole,
} from './helpers.js';

import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { UpdateStudioRequest } from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Public studio projection — same shape as `StudioMeResponseSchema`
 * but declared loosely here so the router never imports the runtime
 * Zod schema for its return type. The shared schema is the wire
 * contract; this interface mirrors it.
 */
export interface StudioView {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly brandColor: string;
    readonly brandLogo: string | null;
}

/** Patch passed to {@link StudiosDeps.updateStudio}. */
export interface StudioPatch {
    readonly name?: string;
    readonly brandColor?: string;
    readonly brandLogo?: string | null;
}

/**
 * Dependencies injected into {@link buildStudiosRouter}. Each method
 * mirrors a use case but stays loosely typed so this module never
 * pulls a domain package directly.
 */
export interface StudiosDeps {
    /**
     * Resolve a studio by id. Returns `null` when the row does not
     * exist (or is soft-deleted) — the router renders that as 404
     * with the canonical `not_found` Problem Details code.
     */
    getStudio(studioId: string): Promise<StudioView | null>;

    /**
     * Update a studio. Returns the new row, or `null` if the studio
     * disappeared between the auth check and the write (e.g. cascading
     * tenant cleanup). The router maps `null` to 404.
     */
    updateStudio(
        studioId: string,
        patch: StudioPatch,
    ): Promise<StudioView | null>;

    /** Dependency bundle forwarded to the idempotency middleware. */
    readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Problem Details helpers                                            */
/* ------------------------------------------------------------------ */

const PROBLEM_JSON = 'application/problem+json';

function problem404(c: Context<HonoEnv>, detail: string): Response {
    return c.body(
        JSON.stringify({
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail,
            code: 'not_found',
            traceId: c.get('traceId'),
        }),
        404,
        { 'content-type': PROBLEM_JSON },
    );
}

function problemLowContrast(
    c: Context<HonoEnv>,
    ratio: number,
): Response {
    return c.body(
        JSON.stringify({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: `brand color contrast ratio ${ratio.toFixed(2)}:1 is below the WCAG AA minimum of 4.5:1`,
            code: 'brand_color_low_contrast',
            traceId: c.get('traceId'),
        }),
        422,
        { 'content-type': PROBLEM_JSON },
    );
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/studios/*` sub-router. */
export function buildStudiosRouter(deps: StudiosDeps): Hono<HonoEnv> {
    const router = new Hono<HonoEnv>();
    const idem = deps.idempotency;

    // Every /v1/studios route requires authentication.
    router.use('*', jwtAuth());

    // Sprint 12 / Slice 12.14 (Epic B4.4) — per-studio burst cap.
    // Self-skips in dev. Default budget 1000 req/60s/studio.
    router.use(
        '*',
        studioRateLimit() as Parameters<typeof router.use>[1],
    );

    /* ------------------------------ GET /me ------------------------ */
    router.get('/me', async (c) => {
        traceOperation(c, 'studios.get-mine');
        const claims = c.get('authClaims');
        if (claims === undefined) {
            throw new Error('authClaims unexpectedly missing after jwtAuth');
        }
        const studio = await deps.getStudio(claims.studioId);
        if (studio === null) {
            // Tenant root row has been hard-deleted under a still-valid
            // session — surface 404 rather than 401 so the client
            // learns the studio is gone, not that its credentials
            // expired. Cross-tenant disclosure is impossible because
            // the lookup is keyed on the JWT-bound `studioId`.
            return problem404(c, 'studio not found');
        }
        return c.json(studio as unknown as Record<string, unknown>, 200);
    });

    /* ------------------------------ PATCH /me (admin) -------------- */
    router.patch(
        '/me',
        requireRole('admin'),
        projectUserIdFromClaims(),
        zValidator('json', UpdateStudioRequestSchema),
        ...(idem ? [idempotency(idem)] : []),
        async (c) => {
            traceOperation(c, 'studios.update-mine');
            const claims = c.get('authClaims');
            if (claims === undefined) {
                throw new Error(
                    'authClaims unexpectedly missing after jwtAuth',
                );
            }
            const patch = readValidated<UpdateStudioRequest>(c, 'json');

            // WCAG AA contrast gate — we run it BEFORE the DB write so
            // a low-contrast color never lands in the row. The check
            // mirrors the runtime pairing emitted by
            // `deriveBrandColorVariables`, so the value the front-end
            // ends up rendering is the one we just validated.
            if (patch.brandColor !== undefined) {
                const evaluation = evaluateBrandContrast(patch.brandColor);
                if (!evaluation.meetsAa) {
                    return problemLowContrast(c, evaluation.ratio);
                }
            }

            const updated = await deps.updateStudio(claims.studioId, patch as unknown as StudioPatch);
            if (updated === null) {
                return problem404(c, 'studio not found');
            }
            return c.json(updated as unknown as Record<string, unknown>, 200);
        },
    );

    return router;
}
