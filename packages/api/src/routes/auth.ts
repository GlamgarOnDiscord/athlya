/**
 * `/v1/auth/*` domain router — task 8.11.
 *
 * Endpoints and their middleware chains (listed in declaration order,
 * which matches the order Hono evaluates them):
 *
 *   | Method | Path                    | Chain                                                              |
 *   |--------|-------------------------|--------------------------------------------------------------------|
 *   | POST   | /register               | turnstile → zValidator(RegisterRequestSchema) → idempotency → handler |
 *   | POST   | /login                  | turnstile → zValidator(LoginRequestSchema) → idempotency → handler |
 *   | POST   | /refresh                | zValidator(RefreshRequestSchema) → handler (NOT idempotent — rotation is single-use) |
 *   | POST   | /logout                 | jwtAuth → handler                                                  |
 *   | DELETE | /me                     | jwtAuth → projectUserIdFromClaims → idempotency → handler          |
 *
 * Requirements:
 *   • 14.1 — JWT verification fronts every authenticated route (all
 *            except `register`, `login`, `refresh`).
 *   • 14.2 — Every route validates its payload via the shared Zod
 *            schemas from `@athlya/shared/schemas/api`.
 *   • 20.1 — Mutation routes mount the idempotency middleware so a
 *            retry with the same `Idempotency-Key` header replays
 *            the cached response.
 *   • 5.1  — `DELETE /me` soft-deletes the authenticated user and
 *            fans out the RGPD deletion cascade.
 *   • 26.1 — `/register` and `/login` sit behind Turnstile.
 *
 * Slice B8.4 — the `/login-with-apple` and `/login-with-google`
 * routes were removed. They previously threw "provider credentials
 * not provisioned yet" (HTTP 500) — exposing them with no working
 * implementation expanded the public attack surface for no
 * functional gain. The OAuth wiring will land in a dedicated slice
 * once Apple / Google developer credentials are provisioned; the
 * deps interface and stub adapters were removed in lockstep.
 *
 * The router is framework-aware (Hono) but service-free: every
 * concrete domain operation comes from the injected
 * {@link AuthDeps} bundle so the module stays trivially
 * unit-testable with `vi.fn()` doubles.
 */

import {
  LoginRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
} from '@athlya/shared/schemas/api';
import { Hono } from 'hono';
import { z } from 'zod';

import { jwtAuth } from '../middleware/auth.js';
import { turnstile } from '../middleware/turnstile.js';
import { zValidator } from '../middleware/validator.js';

import {
  idempotency,
  projectUserIdFromClaims,
  readValidated,
  deriveClientIp,
  traceOperation,
} from './helpers.js';

import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { LoginRequest, RefreshRequest, RegisterRequest } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Lazy import of the shared schemas                                  */
/* ------------------------------------------------------------------ */

// We import schemas lazily so this module's test doubles do not have
// to ship zod. The schemas themselves live in `@athlya/shared` which
// is already a workspace dependency of `@athlya/api`.

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Abstract session payload returned by the auth use cases. The shape
 * intentionally mirrors `SessionResponseSchema` from
 * `@athlya/shared/schemas/api` without importing it at runtime — the
 * router forwards whatever the service returns; the API contract is
 * enforced by the service's own tests and by the gateway's response
 * validation layer (not yet in scope).
 */
export interface AuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly refreshTokenExpiresIn: number;
  readonly user: unknown;
}

/**
 * Per-request context forwarded to {@link AuthDeps.login} so the
 * adapter can key the login-attempt throttle (Req 1.6) on the same
 * `(ip, email)` pair the rate-limit middleware sees.
 *
 * Resolved by the router via {@link deriveClientIp} from the inbound
 * `CF-Connecting-IP` / `X-Forwarded-For` headers; tests building
 * doubles can pass any non-empty string (`'unknown'` is fine).
 */
export interface LoginContext {
  /** Client IP resolved from `cf-connecting-ip` or `x-forwarded-for[0]`. */
  readonly ip: string;
  /**
   * Sprint 12 / Slice 12.15 (Epic B3.4) — Cloudflare ISO-3166
   * alpha-2 country code from `CF-IPCountry`. May be `undefined`
   * in dev / test where Cloudflare does not annotate.
   */
  readonly country?: string;
  /**
   * Sprint 12 / Slice 12.15 (Epic B3.4) — raw `User-Agent`
   * header. May be `undefined` for non-browser clients.
   */
  readonly userAgent?: string;
}

/**
 * Dependencies injected into {@link buildAuthRouter}. Each method
 * mirrors one use case from `@athlya/auth/service` but stays
 * loosely-typed here so the gateway never has to import the service's
 * domain types directly.
 */
export interface AuthDeps {
  register(input: RegisterRequest): Promise<AuthSession>;
  login(input: LoginRequest, ctx: LoginContext): Promise<AuthSession>;
  refresh(input: RefreshRequest): Promise<AuthSession>;
  logout(userId: string): Promise<void>;
  /** Sprint-4 SP4.1 (S2-010) — kick out every active session. */
  logoutAll(userId: string): Promise<void>;
  deleteMe(userId: string): Promise<void>;
  /**
   * Sprint-7 SP7.4 (Vague 35, finalises S2-006) — start the
   * password-reset flow. ALWAYS resolves to `{ kind: 'sent' }`
   * irrespective of email match (email-enumeration defence
   * documented in `@athlya/auth/forgot-password.ts`). The repo
   * + email transport side-effect only fires for active users.
   */
  requestPasswordReset(email: string): Promise<void>;
  /**
   * Sprint-7 SP7.4 — consume a reset token + replace the
   * password. Throws AuthError(`token_invalid` / `token_expired` /
   * `password_breached` / `hibp_unavailable`) on rejection.
   */
  confirmPasswordReset(input: { token: string; newPassword: string }): Promise<void>;

  /** Dependency bundle forwarded to the idempotency middleware. */
  readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the `/v1/auth/*` sub-router.
 *
 * The idempotency middleware requires a non-empty
 * {@link AuthDeps.idempotency.db} handle; callers that do not yet
 * have a Drizzle adapter wired should pass `undefined`, in which case
 * the middleware is skipped entirely (request passes straight through
 * to the handler — safe for tests that do not exercise idempotent
 * replays).
 */
export function buildAuthRouter(deps: AuthDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = deps.idempotency;

  /* ------------------------------ register ----------------------- */
  router.post(
    '/register',
    turnstile(),
    zValidator('json', RegisterRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'auth.register');
      const body = readValidated<RegisterRequest>(c, 'json');
      const session = await deps.register(body);
      return c.json(session, 201);
    },
  );

  /* ------------------------------ login -------------------------- */
  router.post(
    '/login',
    turnstile(),
    zValidator('json', LoginRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'auth.login');
      const body = readValidated<LoginRequest>(c, 'json');
      const ip = deriveClientIp(c.req.header('cf-connecting-ip'), c.req.header('x-forwarded-for'));
      // Sprint 12 / Slice 12.15 (Epic B3.4) — feed
      // CF-IPCountry + User-Agent to the anomaly detector.
      const country = c.req.header('cf-ipcountry');
      const userAgent = c.req.header('user-agent');
      const session = await deps.login(body, {
        ip,
        ...(country !== undefined ? { country } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      });
      return c.json(session, 200);
    },
  );

  /* ------------------------------ refresh ------------------------ */
  // NOT idempotent — the refresh-token rotation is intentionally
  // single-use, so caching the response would defeat the rotation
  // guarantee (Req 2.2).
  router.post('/refresh', zValidator('json', RefreshRequestSchema), async (c) => {
    traceOperation(c, 'auth.refresh');
    const body = readValidated<RefreshRequest>(c, 'json');
    const session = await deps.refresh(body);
    return c.json(session, 200);
  });

  /* ------------------------------ logout ------------------------- */
  router.post('/logout', jwtAuth(), async (c) => {
    traceOperation(c, 'auth.logout');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      // Defensive: jwtAuth always sets authClaims on
      // success, so reaching this branch is a programmer
      // error. Bubble to the global 500 handler rather than
      // silently accepting the logout.
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    await deps.logout(claims.userId);
    return c.body(null, 204);
  });

  /* ------------------------------ logout-all --------------------- */
  // Sprint-4 Slice 4.1 (Vague 32, audit finding S2-010 [HIGH]) —
  // "kick out every device". The user-facing surface is `POST
  // /v1/auth/logout-all` (see `apps/web/src/app/me/security` for
  // the planned UI; out of scope for this slice). Behind a
  // standard JWT challenge — the verified `userId` from the
  // access token authoritatively identifies WHOSE sessions to
  // tear down, so a stolen access token cannot revoke another
  // user's sessions. Idempotent: calling twice on an already-
  // emptied user index is a no-op.
  router.post('/logout-all', jwtAuth(), async (c) => {
    traceOperation(c, 'auth.logout-all');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    await deps.logoutAll(claims.userId);
    return c.body(null, 204);
  });

  /* ------------------------------ password reset --------------- */
  // Sprint-7 SP7.4 (Vague 35, finalises S2-006). Two routes —
  // request + confirm — both behind Turnstile to thwart automated
  // probes. The audit's mitigation also recommends a per-email
  // rate-limit (3 req / 24h) — wired at the gateway level via
  // existing rate-limit middleware extensions, NOT this route file.
  //
  // `request` ALWAYS returns 204 — see the email-enumeration
  // defence rationale in `@athlya/auth/forgot-password.ts`. The
  // service-layer side-effect (insert token + send email) only
  // fires for active users, but the wire response is uniform so
  // an attacker probing email validity gets no signal.
  //
  // `confirm` returns 204 on success. AuthError flow handles the
  // four reject paths (`token_invalid` / `token_expired` /
  // `password_breached` / `hibp_unavailable` — the latter mapping
  // to 503 since Sprint 3).
  const PasswordResetRequestSchema = z.object({ email: z.email().max(254) }).strict();
  const PasswordResetConfirmSchema = z
    .object({
      token: z.string().min(1).max(256),
      // Same length bounds as RegisterRequest — bcrypt hard
      // cap at 72 bytes, minimum 8 chars per OWASP Password
      // Storage Cheatsheet (looser than register's 12 because
      // forced reset is itself a friction point).
      newPassword: z.string().min(8).max(72),
    })
    .strict();

  router.post(
    '/password-reset/request',
    turnstile(),
    zValidator('json', PasswordResetRequestSchema),
    async (c) => {
      traceOperation(c, 'auth.password-reset.request');
      const body = readValidated<{ email: string }>(c, 'json');
      await deps.requestPasswordReset(body.email);
      return c.body(null, 204);
    },
  );

  router.post(
    '/password-reset/confirm',
    turnstile(),
    zValidator('json', PasswordResetConfirmSchema),
    async (c) => {
      traceOperation(c, 'auth.password-reset.confirm');
      const body = readValidated<{ token: string; newPassword: string }>(c, 'json');
      await deps.confirmPasswordReset({
        token: body.token,
        newPassword: body.newPassword,
      });
      return c.body(null, 204);
    },
  );

  /* ------------------------------ delete me ---------------------- */
  router.delete(
    '/me',
    jwtAuth(),
    projectUserIdFromClaims(),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'auth.delete-me');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      await deps.deleteMe(claims.userId);
      return c.json({ deleted: true }, 200);
    },
  );

  return router;
}
