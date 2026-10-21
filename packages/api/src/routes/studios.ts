/**
 * `/v1/studios/*` domain router: slice B9.1 + B9.2, white label (#761).
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path                       | Chain                                                       |
 *   |--------|----------------------------|-------------------------------------------------------------|
 *   | GET    | /me                        | jwtAuth → handler                                           |
 *   | PATCH  | /me                        | jwtAuth → admin → projectUserId → zValidator(body) → idem → handler |
 *   | PUT    | /me/logo/:variant          | jwtAuth → admin → zValidator(param) → handler (raw binary)  |
 *   | DELETE | /me/logo/:variant          | jwtAuth → admin → zValidator(param) → handler               |
 *   | GET    | /me/domains                | jwtAuth → admin → handler                                   |
 *   | PUT    | /me/domains/:kind          | jwtAuth → admin → zValidator(param, body) → handler         |
 *   | DELETE | /me/domains/:kind          | jwtAuth → admin → zValidator(param) → handler               |
 *   | POST   | /me/domains/:kind/check    | jwtAuth → admin → zValidator(param) → handler               |
 *
 * `GET /me` is open to every authenticated role (member / coach /
 * admin): the front-end uses it to retrieve the brand color, logos,
 * slug and display name without inferring them from the JWT. Every
 * other route edits the tenant's branding surface and is admin-only.
 *
 * Validation on `PATCH /me`:
 *   1. Zod whitelists `name` / `brandColor` / `hideAthlyaBranding` and
 *      rejects anything else with a 422 ValidationError envelope.
 *   2. The handler additionally enforces a WCAG 2.2 AA contrast check
 *      whenever `brandColor` changes. Failing colors return 422 with
 *      `code: 'brand_color_low_contrast'`.
 *
 * Logo upload mirrors `PUT /v1/members/me/avatar`: the Content-Type
 * header is the format discriminator, Content-Length is required, the
 * bytes must match the type. Domain checks look the records up in the
 * public DNS (`adapters/doh-resolver.ts`); a resolver failure is a 502,
 * not a failed domain.
 *
 * Requirements:
 *   • 13.2, 13.5 — every read / write is scoped to `claims.studioId`,
 *     never to a path or body parameter.
 *   • 14.1, 14.2, 20.1 — auth / validation / idempotency.
 *   • 15.2 — server-side AA contrast gate.
 */

import {
  SetStudioDomainRequestSchema,
  StudioDomainKindSchema,
  StudioLogoVariantSchema,
  UpdateStudioRequestSchema,
} from '@athlya/shared/schemas/api';
import { evaluateBrandContrast } from '@athlya/shared/theming';
import { Hono } from 'hono';
import { z } from 'zod';

import { AvatarInvalidFormatError } from '../adapters/avatar-upload-store-r2.js';
import { DnsLookupError } from '../adapters/doh-resolver.js';
import { StudioDomainTakenError } from '../adapters/studio-domains-repo-drizzle.js';
import { LOGO_ALLOWED_TYPES, LOGO_MAX_BYTES } from '../adapters/studio-logo-store.js';
import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';
import { StudioDomainCheckCooldownError } from '../white-label/dns-records.js';

import {
  idempotency,
  projectUserIdFromClaims,
  readValidated,
  traceOperation,
  requireRole,
} from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type {
  SetStudioDomainRequest,
  StudioDomain,
  StudioDomainKind,
  StudioLogoVariant,
  UpdateStudioRequest,
} from '@athlya/shared/schemas/api';
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
  readonly brandLogoLight: string | null;
  readonly brandLogoDark: string | null;
  readonly hideAthlyaBranding: boolean;
}

/** Patch passed to {@link StudiosDeps.updateStudio}. */
export interface StudioPatch {
  readonly name?: string;
  readonly brandColor?: string;
  readonly hideAthlyaBranding?: boolean;
}

/**
 * Dependencies injected into {@link buildStudiosRouter}. Each method
 * mirrors a use case but stays loosely typed so this module never
 * pulls a domain package directly. `claims` scope every query through
 * RLS (`withTenantHttp`).
 */
export interface StudiosDeps {
  /**
   * Resolve a studio by id. Returns `null` when the row does not
   * exist (or is soft-deleted) — the router renders that as 404
   * with the canonical `not_found` Problem Details code.
   */
  getStudio(studioId: string, claims: AuthClaims): Promise<StudioView | null>;

  /**
   * Update a studio. Returns the new row, or `null` if the studio
   * disappeared between the auth check and the write (e.g. cascading
   * tenant cleanup). The router maps `null` to 404.
   */
  updateStudio(
    studioId: string,
    patch: StudioPatch,
    claims: AuthClaims,
  ): Promise<StudioView | null>;

  /**
   * Store a logo and save it on the studio row.
   *
   * @throws {AvatarInvalidFormatError} when the bytes do not match the type.
   */
  uploadLogo(
    variant: StudioLogoVariant,
    contentType: string,
    body: ArrayBuffer,
    claims: AuthClaims,
  ): Promise<StudioView | null>;

  /** Remove a logo from the studio row (and from storage). */
  removeLogo(variant: StudioLogoVariant, claims: AuthClaims): Promise<StudioView | null>;

  /** Domains registered by the caller's studio. */
  listDomains(claims: AuthClaims): Promise<readonly StudioDomain[]>;

  /** Register or replace the hostname of `kind`. */
  setDomain(kind: StudioDomainKind, hostname: string, claims: AuthClaims): Promise<StudioDomain>;

  /** Drop the domain of `kind`; `false` when there was none. */
  removeDomain(kind: StudioDomainKind, claims: AuthClaims): Promise<boolean>;

  /**
   * Look the records of `kind` up in the public DNS and save the
   * verdict. `null` when the studio has no domain of that kind.
   *
   * @throws {StudioDomainCheckCooldownError} when checked moments ago.
   * @throws {DnsLookupError} when the resolver fails.
   * @throws {StudioDomainTakenError} when another studio verified it.
   */
  checkDomain(kind: StudioDomainKind, claims: AuthClaims): Promise<StudioDomain | null>;

  /** Dependency bundle forwarded to the idempotency middleware. */
  readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Problem Details helpers                                            */
/* ------------------------------------------------------------------ */

const PROBLEM_JSON = 'application/problem+json';

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  411: 'Length Required',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
};

function problem(
  c: Context<HonoEnv>,
  status: 400 | 404 | 409 | 411 | 413 | 415 | 422 | 429 | 502,
  detail: string,
  code: string,
  headers: Record<string, string> = {},
): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: TITLES[status],
      status,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    status,
    { 'content-type': PROBLEM_JSON, ...headers },
  );
}

function problem404(c: Context<HonoEnv>, detail: string): Response {
  return problem(c, 404, detail, 'not_found');
}

function requireClaims(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) {
    throw new Error('authClaims unexpectedly missing after jwtAuth');
  }
  return claims;
}

const LogoParamSchema = z.object({ variant: StudioLogoVariantSchema });
const DomainParamSchema = z.object({ kind: StudioDomainKindSchema });

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
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  /* ------------------------------ GET /me ------------------------ */
  router.get('/me', async (c) => {
    traceOperation(c, 'studios.get-mine');
    const claims = requireClaims(c);
    const studio = await deps.getStudio(claims.studioId, claims);
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
      const claims = requireClaims(c);
      const patch = readValidated<UpdateStudioRequest>(c, 'json');

      // WCAG AA contrast gate — we run it BEFORE the DB write so
      // a low-contrast color never lands in the row. The check
      // mirrors the runtime pairing emitted by
      // `deriveBrandColorVariables`, so the value the front-end
      // ends up rendering is the one we just validated.
      if (patch.brandColor !== undefined) {
        const evaluation = evaluateBrandContrast(patch.brandColor);
        if (!evaluation.meetsAa) {
          return problem(
            c,
            422,
            `brand color contrast ratio ${evaluation.ratio.toFixed(2)}:1 is below the WCAG AA minimum of 4.5:1`,
            'brand_color_low_contrast',
          );
        }
      }

      const updated = await deps.updateStudio(
        claims.studioId,
        patch as unknown as StudioPatch,
        claims,
      );
      if (updated === null) {
        return problem404(c, 'studio not found');
      }
      return c.json(updated as unknown as Record<string, unknown>, 200);
    },
  );

  /* ------------------------------ PUT /me/logo/:variant ---------- */
  router.put(
    '/me/logo/:variant',
    requireRole('admin'),
    zValidator('param', LogoParamSchema),
    async (c) => {
      traceOperation(c, 'studios.upload-logo');
      const claims = requireClaims(c);
      const { variant } = readValidated<z.infer<typeof LogoParamSchema>>(c, 'param');

      const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!LOGO_ALLOWED_TYPES.has(contentType)) {
        return problem(
          c,
          415,
          'Content-Type must be image/jpeg, image/png, or image/webp',
          'unsupported_media_type',
        );
      }
      const rawLength = c.req.header('content-length');
      if (rawLength === undefined) {
        return problem(c, 411, 'Content-Length is required for logo uploads', 'length_required');
      }
      if (!/^\d+$/u.test(rawLength)) {
        return problem(
          c,
          400,
          'Content-Length must be a non-negative decimal integer',
          'invalid_content_length',
        );
      }
      const tooLarge = `Logo must not exceed ${String(LOGO_MAX_BYTES / 1024)} KiB`;
      if (Number(rawLength) > LOGO_MAX_BYTES) {
        return problem(c, 413, tooLarge, 'logo_too_large');
      }
      const body = await c.req.raw.arrayBuffer();
      if (body.byteLength > LOGO_MAX_BYTES) {
        return problem(c, 413, tooLarge, 'logo_too_large');
      }
      if (body.byteLength === 0) {
        return problem(c, 400, 'Body must not be empty', 'empty_body');
      }

      try {
        const updated = await deps.uploadLogo(variant, contentType, body, claims);
        if (updated === null) return problem404(c, 'studio not found');
        return c.json(updated as unknown as Record<string, unknown>, 200);
      } catch (err) {
        if (err instanceof AvatarInvalidFormatError) {
          return problem(
            c,
            422,
            'File content does not match declared content type',
            'logo_invalid_format',
          );
        }
        throw err;
      }
    },
  );

  /* ------------------------------ DELETE /me/logo/:variant ------- */
  router.delete(
    '/me/logo/:variant',
    requireRole('admin'),
    zValidator('param', LogoParamSchema),
    async (c) => {
      traceOperation(c, 'studios.remove-logo');
      const claims = requireClaims(c);
      const { variant } = readValidated<z.infer<typeof LogoParamSchema>>(c, 'param');
      const updated = await deps.removeLogo(variant, claims);
      if (updated === null) return problem404(c, 'studio not found');
      return c.json(updated as unknown as Record<string, unknown>, 200);
    },
  );

  /* ------------------------------ GET /me/domains ---------------- */
  router.get('/me/domains', requireRole('admin'), async (c) => {
    traceOperation(c, 'studios.list-domains');
    const items = await deps.listDomains(requireClaims(c));
    return c.json({ items }, 200);
  });

  /* ------------------------------ PUT /me/domains/:kind ---------- */
  router.put(
    '/me/domains/:kind',
    requireRole('admin'),
    zValidator('param', DomainParamSchema),
    zValidator('json', SetStudioDomainRequestSchema),
    async (c) => {
      traceOperation(c, 'studios.set-domain');
      const claims = requireClaims(c);
      const { kind } = readValidated<z.infer<typeof DomainParamSchema>>(c, 'param');
      const { hostname } = readValidated<SetStudioDomainRequest>(c, 'json');
      const domain = await deps.setDomain(kind, hostname, claims);
      return c.json(domain, 200);
    },
  );

  /* ------------------------------ DELETE /me/domains/:kind ------- */
  router.delete(
    '/me/domains/:kind',
    requireRole('admin'),
    zValidator('param', DomainParamSchema),
    async (c) => {
      traceOperation(c, 'studios.remove-domain');
      const claims = requireClaims(c);
      const { kind } = readValidated<z.infer<typeof DomainParamSchema>>(c, 'param');
      const removed = await deps.removeDomain(kind, claims);
      if (!removed) return problem404(c, 'domain not found');
      return c.body(null, 204);
    },
  );

  /* ------------------------------ POST /me/domains/:kind/check --- */
  router.post(
    '/me/domains/:kind/check',
    requireRole('admin'),
    zValidator('param', DomainParamSchema),
    async (c) => {
      traceOperation(c, 'studios.check-domain');
      const claims = requireClaims(c);
      const { kind } = readValidated<z.infer<typeof DomainParamSchema>>(c, 'param');
      try {
        const domain = await deps.checkDomain(kind, claims);
        if (domain === null) return problem404(c, 'domain not found');
        return c.json(domain, 200);
      } catch (err) {
        if (err instanceof StudioDomainCheckCooldownError) {
          return problem(c, 429, 'The domain was checked moments ago', 'domain_check_cooldown', {
            'retry-after': String(err.retryAfterSeconds),
          });
        }
        if (err instanceof DnsLookupError) {
          return problem(c, 502, 'The DNS lookup failed, try again', 'dns_lookup_failed');
        }
        if (err instanceof StudioDomainTakenError) {
          return problem(
            c,
            409,
            'This hostname is already verified for another studio',
            'domain_taken',
          );
        }
        throw err;
      }
    },
  );

  return router;
}
