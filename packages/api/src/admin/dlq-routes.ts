/**
 * Admin HTTP surface for the DLQ tracker — hardening task H2.
 *
 * Mounts three routes under `/admin/dlq` that let a Studio operator
 * (role = `admin`) see what is stuck in the DLQ, replay a specific
 * entry, or give up on one:
 *
 *   • `GET  /admin/dlq/stats`            → JSON snapshot
 *   • `POST /admin/dlq/replay/:id`       → send the payload back onto
 *                                          the main events queue
 *   • `POST /admin/dlq/discard/:id`      → drop the entry from the
 *                                          tracker without re-publishing
 *
 * Every route first checks `c.get('authClaims')?.role === 'admin'`.
 * Non-admin requests (including anonymous ones that never reached
 * the auth middleware) are rejected with HTTP 403 Problem Details.
 * Unknown ids on `/replay/:id` surface as 404 Problem Details.
 *
 * This module deliberately does NOT touch the main `app` singleton.
 * Mount-site composition is task 8.11's responsibility (tracked in
 * `hardening-plan.md` under H2 as "DO NOT mount this on `worker.ts`
 * — just export `buildDlqRouter`"). Keeping the wiring at arm's
 * length means:
 *
 *   1. Tests can exercise the router in isolation against a tiny
 *      Hono instance with a stubbed env, no middleware chain.
 *   2. Production can decide whether to mount the routes on the
 *      public gateway, behind a separate admin subdomain, or only in
 *      internal tooling.
 *
 * Why Hono here and not a framework-free layer?
 * ---------------------------------------------
 * The core (`events/drain-dlq.ts`) is deliberately framework-free —
 * it is reused by the queue consumer and must stay thin. The admin
 * wrapper on top of it is admin-only UI plumbing; pulling in Hono
 * for route matching and JSON serialisation is a tiny amount of
 * runtime cost and the alternative (rolling our own matcher) would
 * reinvent the middleware we already trust everywhere else.
 */

import { Hono } from 'hono';

import { dlqDiscard, dlqReplay, dlqStats } from '../events/drain-dlq.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../middleware/problem-details.js';

import type { DlqBindings, DlqEntry } from '../events/drain-dlq.js';
import type { AthlyaVariables } from '../types.js';
import type { Context } from 'hono';

/* ------------------------------------------------------------------ */
/*  Hono environment                                                   */
/* ------------------------------------------------------------------ */

/**
 * Environment shape this router is generic over. We narrow the
 * bindings down to {@link DlqBindings} (rather than reaching for the
 * full {@link import('../types.js').AthlyaBindings}) so the router
 * advertises exactly what it needs at the type level. Domain
 * variables flow through unchanged because every admin action wants
 * access to the trace id + per-request logger set up by the gateway.
 */
export interface DlqAdminEnv {
  Bindings: DlqBindings;
  Variables: AthlyaVariables;
}

/* ------------------------------------------------------------------ */
/*  Problem Details helpers                                            */
/* ------------------------------------------------------------------ */

/** Problem Details `type` URI prefix for Athlya-specific errors. */
const ATHLYA_PROBLEM_NAMESPACE = 'https://athlya.app/problems/';

/** `type` URI for the 403 forbidden envelope. */
const FORBIDDEN_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}forbidden`;

/** `type` URI for the 404 not-found envelope the replay route uses. */
const NOT_FOUND_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}not-found`;

/** Shape of the Problem Details body the router emits on failures. */
interface AdminProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly traceId: string;
}

/**
 * Build a Problem Details JSON body. Kept local to this module so
 * the admin surface ships a tiny, self-contained envelope rather
 * than reaching into the generic mapper — the generic mapper fires
 * from `app.onError`, but we want tightly-controlled wire shapes for
 * the 403 and 404 paths (they are the entire admin API contract).
 */
function buildProblem(
  status: number,
  title: string,
  code: string,
  detail: string,
  traceId: string,
  type: string,
): AdminProblemBody {
  return { type, title, status, detail, code, traceId };
}

/**
 * Emit a Problem Details response using Hono's `c.body` so we pin
 * `content-type: application/problem+json` per RFC 9457. `c.json`
 * would stamp `application/json` on top.
 */
function problemResponse(c: Context<DlqAdminEnv>, body: AdminProblemBody): Response {
  return c.body(JSON.stringify(body), body.status as 403 | 404, {
    'content-type': PROBLEM_JSON_CONTENT_TYPE,
  });
}

/* ------------------------------------------------------------------ */
/*  Admin guard                                                        */
/* ------------------------------------------------------------------ */

/**
 * Check the request's auth claims and, when the caller is not an
 * admin, return a fully-formed 403 Response. On a pass, returns
 * `null` so the handler can keep going.
 *
 * Deliberately permissive at the type level (`c.get('authClaims')`
 * returns `AuthClaims | undefined` in practice but `unknown` at the
 * Variables type level in some contexts) — we treat anything that is
 * not `{ role: 'admin' }` as a deny.
 */
function enforceAdmin(c: Context<DlqAdminEnv>): Response | null {
  const claims = c.get('authClaims');
  if (claims === undefined || claims === null) {
    return problemResponse(
      c,
      buildProblem(
        403,
        'Forbidden',
        'forbidden',
        'admin role required',
        c.get('traceId'),
        FORBIDDEN_TYPE,
      ),
    );
  }
  if (claims.role !== 'admin') {
    return problemResponse(
      c,
      buildProblem(
        403,
        'Forbidden',
        'forbidden',
        'admin role required',
        c.get('traceId'),
        FORBIDDEN_TYPE,
      ),
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  buildDlqRouter                                                     */
/* ------------------------------------------------------------------ */

/**
 * Response body shape of `GET /admin/dlq/stats`. Matches the
 * structural output of {@link dlqStats} verbatim; declared as an
 * interface so consumers (admin UI, integration tests) can import it.
 */
export interface DlqStatsResponse {
  readonly pending: number;
  readonly oldestAgeMs: number | null;
  readonly entries: readonly DlqEntry[];
}

/**
 * Build the admin sub-router. Caller is expected to either:
 *
 *   a. Mount the returned router on the main gateway, behind an auth
 *      middleware that populates `c.get('authClaims')`, OR
 *   b. Mount it on a separate admin app that runs its own auth
 *      middleware chain.
 *
 * The router does NOT install the auth middleware itself on
 * purpose: different deployment topologies call for different
 * middlewares (Clerk JWT on the public gateway, Workers IAM inside
 * an internal tool, etc.), and forcing one here would tie the admin
 * surface to a single distribution.
 */
export function buildDlqRouter(): Hono<DlqAdminEnv> {
  const router = new Hono<DlqAdminEnv>();

  /* -------------------------------------------------------------- */
  /*  GET /admin/dlq/stats                                          */
  /* -------------------------------------------------------------- */

  router.get('/admin/dlq/stats', async (c) => {
    const forbidden = enforceAdmin(c);
    if (forbidden !== null) return forbidden;

    const snapshot = await dlqStats(c.env);
    const body: DlqStatsResponse = {
      pending: snapshot.pending,
      oldestAgeMs: snapshot.oldestAgeMs,
      entries: snapshot.entries,
    };
    return c.json(body, 200);
  });

  /* -------------------------------------------------------------- */
  /*  POST /admin/dlq/replay/:id                                    */
  /* -------------------------------------------------------------- */

  router.post('/admin/dlq/replay/:id', async (c) => {
    const forbidden = enforceAdmin(c);
    if (forbidden !== null) return forbidden;

    const id = c.req.param('id');
    const result = await dlqReplay(c.env, id);
    if (!result.replayed) {
      // `reason` is `'not_found'` for a missing id; any other
      // future reason ({@link dlqReplay} may grow more) falls
      // into the same 404 bucket for now. When a new reason
      // warrants a different status, extend the dispatch here.
      return problemResponse(
        c,
        buildProblem(
          404,
          'Not Found',
          'dlq_entry_not_found',
          `DLQ entry ${id} not found`,
          c.get('traceId'),
          NOT_FOUND_TYPE,
        ),
      );
    }
    return c.json({ replayed: true }, 200);
  });

  /* -------------------------------------------------------------- */
  /*  POST /admin/dlq/discard/:id                                   */
  /* -------------------------------------------------------------- */

  router.post('/admin/dlq/discard/:id', async (c) => {
    const forbidden = enforceAdmin(c);
    if (forbidden !== null) return forbidden;

    const id = c.req.param('id');
    const result = await dlqDiscard(c.env, id);
    return c.json({ discarded: result.discarded }, 200);
  });

  return router;
}
