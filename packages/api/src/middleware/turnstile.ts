/**
 * Cloudflare Turnstile verification middleware (task 8.9).
 *
 * Satisfies Requirements 26.1, 26.2 and 26.3 of the Athlya platform
 * spec:
 *
 *   • 26.1 — the member-facing web/mobile forms surface a Turnstile
 *            challenge on `/v1/auth/register` and `/v1/auth/login`.
 *   • 26.2 — the gateway re-validates the `cf-turnstile-token` header
 *            against Cloudflare's siteverify endpoint BEFORE forwarding
 *            the request to the Auth service.
 *   • 26.3 — a failed challenge (missing header, expired token,
 *            wrong-hostname, siteverify transport failure, …) surfaces
 *            as `HTTP 403 bot_challenge_failed` without the Auth
 *            service ever being invoked.
 *
 * The middleware is framework-free: it duck-types the subset of the
 * Hono `Context` it touches (header read, env bindings, `body`
 * response writer, `get(traceId/logger)`). Tests drop in a minimal
 * fake context backed by `vi.fn()` calls; the production wiring
 * consumes a full `Context<HonoEnv>` by structural typing.
 *
 * ### Turnstile secret handling
 *
 * The shared secret lives under the `TURNSTILE_SECRET` binding
 * (declared in `wrangler.toml` as a Wrangler secret). The factory
 * accepts a pre-resolved secret via {@link TurnstileOptions.secret} or
 * falls back to `c.env.TURNSTILE_SECRET`. Missing-secret policy:
 *
 *   • `ENVIRONMENT === 'dev'` — emits a single `warn` and calls
 *     `next()`. Local-dev productivity wins over paranoia here; the
 *     public endpoints cannot be reached from the Internet in a dev
 *     deployment.
 *   • Any other environment — responds `500 configuration_error` so
 *     a missing-secret deploy is loud, not silent. The operator's
 *     on-call channel gets the page; no user request slips past
 *     Turnstile.
 *
 * ### siteverify protocol
 *
 * Cloudflare's `/turnstile/v0/siteverify` endpoint accepts an
 * `application/x-www-form-urlencoded` POST with `secret`, `response`
 * (the client token) and optionally `remoteip`. The response is
 * JSON:
 *
 *   ```json
 *   { "success": true, "challenge_ts": "2024-…", "hostname": "…",
 *     "error-codes": [] }
 *   ```
 *
 * We treat any non-`success` outcome (plus non-2xx, fetch rejection,
 * timeout) as a 403. `error-codes` is logged at `warn` level for
 * observability but never surfaced in the HTTP body — leaking them
 * would help attackers distinguish between "wrong-hostname" and
 * "token-already-spent" and tune their probes.
 */

import type { AthlyaEnvironment } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Cloudflare's canonical siteverify endpoint. Exported for tests. */
export const CLOUDFLARE_SITEVERIFY_URL =
    'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Problem Details content-type per RFC 9457. */
const PROBLEM_JSON = 'application/problem+json';

/** Header name the web / mobile clients stamp on the outbound request. */
export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-token';

/** Default siteverify request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5_000;

/* ------------------------------------------------------------------ */
/*  Context shape (framework-free)                                     */
/* ------------------------------------------------------------------ */

/**
 * Minimal logger surface the middleware calls into. Structural subset
 * of {@link import('../logging.js').StructuredLogger}; declared here
 * so this module has no runtime dependency on `logging.ts`.
 */
export interface TurnstileLogger {
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Worker bindings the middleware looks at. Narrower than the full
 * {@link import('../types.js').AthlyaBindings} surface — only the
 * Turnstile secret and environment discriminator are required.
 */
export interface TurnstileEnv {
    readonly ENVIRONMENT: AthlyaEnvironment;
    readonly TURNSTILE_SECRET?: string;
}

/** Minimal request-header reader. Hono's `c.req.header(name)` matches. */
export interface TurnstileRequest {
    header(name: string): string | undefined;
}

/**
 * Framework-free context shape accepted by {@link turnstile}.
 *
 * Hono's `Context<HonoEnv>` satisfies this interface structurally —
 * the middleware never imports Hono. `body` carries the response
 * builder; the middleware only ever writes 403 / 500 through it.
 */
export interface TurnstileContext {
    readonly env: TurnstileEnv;
    readonly req: TurnstileRequest;
    get(key: 'traceId'): unknown;
    get(key: 'logger'): unknown;
    body(
        data: string,
        status: number,
        headers: Record<string, string>,
    ): Response;
}

/** Hono-compatible `next()` signature. */
export type TurnstileNext = () => Promise<void>;

/**
 * Middleware handler signature. Returning a `Response` short-circuits
 * the chain; `undefined` (via `await next()`) lets the request
 * through.
 */
export type TurnstileMiddleware = (
    c: TurnstileContext,
    next: TurnstileNext,
) => Promise<Response | void>;

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

/**
 * Subset of Cloudflare's siteverify response the middleware cares
 * about. `success` is the only field consulted on the success branch;
 * `error-codes` is surfaced to the logger on failures.
 */
interface SiteverifyResponse {
    readonly success: boolean;
    readonly ['error-codes']?: readonly string[];
    readonly hostname?: string;
}

/** Options accepted by {@link turnstile}. Every field is optional. */
export interface TurnstileOptions {
    /**
     * Pre-resolved Turnstile secret. When omitted, the middleware
     * reads `c.env.TURNSTILE_SECRET` on every request.
     */
    readonly secret?: string;

    /**
     * Override for the siteverify endpoint. Tests point this at a
     * local HTTP server or a `vi.fn()`-backed `fetch` stub;
     * production uses {@link CLOUDFLARE_SITEVERIFY_URL}.
     */
    readonly siteverifyUrl?: string;

    /**
     * Injected `fetch`. Defaults to `globalThis.fetch`. Tests swap in
     * a `vi.fn<typeof fetch>()` to record the outbound POST without
     * hitting the network.
     */
    readonly fetch?: typeof fetch;

    /**
     * Timeout for the siteverify call in milliseconds. Default
     * {@link DEFAULT_TIMEOUT_MS}. Expiring the timer aborts the
     * outbound fetch and logs `turnstile verification timed out` at
     * `warn` level.
     */
    readonly timeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/*  Problem Details body builders                                      */
/* ------------------------------------------------------------------ */

interface ProblemBody {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly traceId: string;
    readonly code: string;
}

/**
 * Build the 403 `bot_challenge_failed` Problem Details body. `type`
 * uses `about:blank` per the convention in the sibling 401 / 404
 * paths pending task 8.5's full RFC 9457 catalogue lift.
 */
function build403(c: TurnstileContext): Response {
    const body: ProblemBody = {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        traceId: readTraceId(c),
        code: 'bot_challenge_failed',
    };
    return c.body(JSON.stringify(body), 403, {
        'content-type': PROBLEM_JSON,
    });
}

/**
 * Build the 500 `configuration_error` Problem Details body. Emitted
 * only on missing-secret in `staging` / `production`. Unlike the 403
 * branches, this is a loud deployment error: on-call gets paged and
 * no user request is allowed past.
 */
function build500ConfigError(c: TurnstileContext): Response {
    const body: ProblemBody = {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        traceId: readTraceId(c),
        code: 'configuration_error',
    };
    return c.body(JSON.stringify(body), 500, {
        'content-type': PROBLEM_JSON,
    });
}

/* ------------------------------------------------------------------ */
/*  Context readers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Read `traceId` from the context, defaulting to `'unknown'` when
 * absent. The tracing middleware in `worker.ts` guarantees it is set
 * for every request served by the gateway; defaulting keeps this
 * module usable outside Hono for scripts / tests.
 */
function readTraceId(c: TurnstileContext): string {
    const raw = c.get('traceId');
    return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

/**
 * Read `logger` from the context. Returns a no-op logger when the
 * value is missing — the middleware must never throw on a missing
 * logger, since that would make a misconfigured test crash noisily
 * in the wrong place.
 */
function readLogger(c: TurnstileContext): TurnstileLogger {
    const raw = c.get('logger');
    if (
        raw !== null &&
        typeof raw === 'object' &&
        'warn' in raw &&
        'error' in raw
    ) {
        return raw as TurnstileLogger;
    }
    return {
        warn: () => undefined,
        error: () => undefined,
    };
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the Turnstile verification middleware.
 *
 * Behaviour per request, in order:
 *
 *   1. Read `cf-turnstile-token`. Missing / empty / whitespace-only
 *      → 403 + `turnstile token missing` warn log. `next()` is NOT
 *      called.
 *   2. Resolve the shared secret: `options.secret` wins, otherwise
 *      `c.env.TURNSTILE_SECRET`. Absent:
 *        • `ENVIRONMENT === 'dev'` — single `warn`, call `next()`.
 *        • `ENVIRONMENT ∈ { staging, production }` — 500
 *          `configuration_error`, `error` log.
 *   3. POST `(secret, response, remoteip?)` to the siteverify
 *      endpoint over `application/x-www-form-urlencoded` with the
 *      configured timeout.
 *        • Timeout → 403 + `turnstile verification timed out` warn.
 *        • Fetch rejection → 403 + `turnstile verification network
 *          error` warn.
 *        • Non-2xx response → 403 + `turnstile verification
 *          rejected` warn (reason `non_2xx`, upstream status).
 *        • `success: false` → 403 + `turnstile verification rejected`
 *          warn (reason `failure`, error-codes).
 *   4. `success: true` → call `next()` (no response emitted).
 *
 * Caching is intentionally not attempted: each token is single-use
 * per Cloudflare's documentation, so caching would break the
 * anti-replay invariant.
 */
export function turnstile(
    options: TurnstileOptions = {},
): TurnstileMiddleware {
    const siteverifyUrl = options.siteverifyUrl ?? CLOUDFLARE_SITEVERIFY_URL;
    const fetchImpl = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return async (c, next) => {
        const logger = readLogger(c);
        const traceId = readTraceId(c);

        // -------- Step 1: token presence --------
        const token = c.req.header(TURNSTILE_TOKEN_HEADER);
        if (token === undefined || token.trim().length === 0) {
            logger.warn('turnstile token missing', { traceId });
            return build403(c);
        }

        // -------- Step 2: secret resolution --------
        const secret = options.secret ?? c.env.TURNSTILE_SECRET;
        if (secret === undefined || secret.length === 0) {
            if (c.env.ENVIRONMENT === 'dev') {
                logger.warn('turnstile bypassed in dev', { traceId });
                await next();
                return;
            }
            logger.error('turnstile secret missing', {
                traceId,
                environment: c.env.ENVIRONMENT,
            });
            return build500ConfigError(c);
        }

        // -------- Step 3: siteverify round-trip --------
        const remoteIp = c.req.header('CF-Connecting-IP');

        const form = new URLSearchParams();
        form.set('secret', secret);
        form.set('response', token.trim());
        if (remoteIp !== undefined && remoteIp.trim().length > 0) {
            form.set('remoteip', remoteIp.trim());
        }

        const controller = new AbortController();
        const timeoutHandle = setTimeout(
            () => controller.abort(),
            timeoutMs,
        );

        let outcome: SiteverifyResponse;
        try {
            const res = await fetchImpl(siteverifyUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                },
                body: form.toString(),
                signal: controller.signal,
            });

            if (!res.ok) {
                logger.warn('turnstile verification rejected', {
                    traceId,
                    reason: 'non_2xx',
                    upstreamStatus: res.status,
                });
                return build403(c);
            }

            outcome = (await res.json());
        } catch (err) {
            // AbortError surfaces as either DOMException or a
            // generic Error with `name === 'AbortError'` depending
            // on the runtime. Cover both.
            const name =
                err instanceof Error
                    ? err.name
                    : typeof err === 'object' && err !== null && 'name' in err
                        ? String((err as { name?: unknown }).name)
                        : '';
            if (name === 'AbortError') {
                logger.warn('turnstile verification timed out', {
                    traceId,
                    timeoutMs,
                });
                return build403(c);
            }
            logger.warn('turnstile verification network error', {
                traceId,
                error: err instanceof Error ? err.message : String(err),
            });
            return build403(c);
        } finally {
            clearTimeout(timeoutHandle);
        }

        // -------- Step 4: success / rejection --------
        if (!outcome.success) {
            logger.warn('turnstile verification rejected', {
                traceId,
                reason: 'failure',
                errorCodes: outcome['error-codes'] ?? [],
            });
            return build403(c);
        }

        await next();
        return;
    };
}
