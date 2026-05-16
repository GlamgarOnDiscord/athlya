/**
 * Unit tests for the Problem Details error mapper (task 8.5).
 *
 * Covers every branch of the {@link toProblemResponse} priority
 * table:
 *
 *   1. `ValidationError` → 422 with `errors: [{ path, message, code }]`
 *      drawn from the Zod issues.
 *   2. `MissingAuthClaimsError` → 401 with the unauthenticated `type`
 *      URI and `code: 'missing_auth_claims'`.
 *   3. `TenantResourceNotFoundError` → 404, reusing
 *      `tenantErrorToProblem`'s body, with `traceId` filled in.
 *   4. Generic `Error` (and non-Error thrown values) → 500 with
 *      `about:blank` and a body that does NOT leak `err.message` or
 *      `err.stack` (secret-leak guard).
 *   5. `registerErrorHandlers(app)` wires the mapper into a
 *      Hono-like `app.onError(…)` call site — tested via a minimal
 *      duck-typed fake.
 *
 * Validates: Requirements 14.2, 14.6.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    PROBLEM_JSON_CONTENT_TYPE,
    registerErrorHandlers,
    toProblemResponse,
} from '../middleware/problem-details.js';
import {
    MissingAuthClaimsError,
    TenantResourceNotFoundError,
} from '../middleware/tenant.js';
import { ValidationError } from '../middleware/validator.js';

import type {
    ErrorHandlerContext,
    HonoLikeApp,
    ProblemContext,
    ProblemLogger,
} from '../middleware/problem-details.js';
import type { ZodIssue } from '../middleware/validator.js';
import type { MockInstance } from 'vitest';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface LoggerSpy {
    warn: MockInstance;
    error: MockInstance;
}

/**
 * Build a {@link ProblemContext} whose logger methods are vi mocks
 * so the test can assert level + fields on the emitted line.
 */
function fakeCtx(traceId = 'trace-123'): ProblemContext & {
    logger: LoggerSpy;
} {
    const logger: ProblemLogger & LoggerSpy = {
        warn: vi.fn(),
        error: vi.fn(),
    };
    return { traceId, logger };
}

/* ------------------------------------------------------------------ */
/*  ValidationError                                                    */
/* ------------------------------------------------------------------ */

describe('toProblemResponse — ValidationError', () => {
    it('maps to 422 with the validation type URI and an errors array', () => {
        const issues: ZodIssue[] = [
            {
                code: 'invalid_type',
                expected: 'string',
                path: ['email'],
                message: 'Expected string',
                input: 123,
            },
            {
                code: 'too_small',
                origin: 'number',
                minimum: 18,
                path: ['profile', 'age'],
                message: 'Too small',
                input: 10,
            },
        ];
        const err = new ValidationError('json', issues);

        const ctx = fakeCtx('trace-abc');
        const { status, body } = toProblemResponse(err, ctx);

        expect(status).toBe(422);
        expect(body.type).toBe('https://athlya.app/problems/validation-error');
        expect(body.title).toBe('Unprocessable Entity');
        expect(body.status).toBe(422);
        expect(body.code).toBe('validation_error');
        expect(body.traceId).toBe('trace-abc');
        expect(body.errors).toEqual([
            { path: 'email', message: 'Expected string', code: 'invalid_type' },
            { path: 'profile.age', message: 'Too small', code: 'too_small' },
        ]);
    });

    it('logs at warn level with the error name and code, NOT the message', () => {
        const err = new ValidationError('query', []);
        const ctx = fakeCtx('trace-q');

        toProblemResponse(err, ctx);

        expect(ctx.logger.error).not.toHaveBeenCalled();
        expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
        const [, fields] = ctx.logger.warn.mock.calls[0] as [
            string,
            Record<string, unknown>,
        ];
        expect(fields).toMatchObject({
            traceId: 'trace-q',
            status: 422,
            errorName: 'ValidationError',
            errorCode: 'validation_error',
        });
        expect(fields.errorMessage).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/*  MissingAuthClaimsError                                             */
/* ------------------------------------------------------------------ */

describe('toProblemResponse — MissingAuthClaimsError', () => {
    it('maps to 401 with the unauthenticated type URI and missing_auth_claims code', () => {
        const err = new MissingAuthClaimsError();
        const ctx = fakeCtx('trace-auth');

        const { status, body } = toProblemResponse(err, ctx);

        expect(status).toBe(401);
        expect(body).toMatchObject({
            type: 'https://athlya.app/problems/unauthenticated',
            title: 'Unauthorized',
            status: 401,
            code: 'missing_auth_claims',
            traceId: 'trace-auth',
        });
        expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
        expect(ctx.logger.error).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  TenantResourceNotFoundError                                        */
/* ------------------------------------------------------------------ */

describe('toProblemResponse — TenantResourceNotFoundError', () => {
    it('maps to 404 and echoes the traceId from the context', () => {
        const err = new TenantResourceNotFoundError('reservation 42');
        const ctx = fakeCtx('trace-nf');

        const { status, body } = toProblemResponse(err, ctx);

        expect(status).toBe(404);
        expect(body.status).toBe(404);
        expect(body.title).toBe('Not Found');
        expect(body.code).toBe('not_found');
        expect(body.traceId).toBe('trace-nf');
        expect(body.detail).toBe('reservation 42');
        expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    });
});

/* ------------------------------------------------------------------ */
/*  Fallback / secret-leak guard                                       */
/* ------------------------------------------------------------------ */

describe('toProblemResponse — generic Error fallback', () => {
    it('maps to 500 with about:blank and no detail/code', () => {
        const err = new Error('boom');
        const ctx = fakeCtx('trace-500');

        const { status, body } = toProblemResponse(err, ctx);

        expect(status).toBe(500);
        expect(body).toMatchObject({
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            traceId: 'trace-500',
        });
        expect(body.detail).toBeUndefined();
        expect(body.code).toBeUndefined();
        expect(body.errors).toBeUndefined();
    });

    it('does NOT leak err.message into the response body (secret-leak guard)', () => {
        const secret = 'db password is hunter2';
        const err = new Error(secret);
        const ctx = fakeCtx('trace-leak');

        const { body } = toProblemResponse(err, ctx);
        const serialised = JSON.stringify(body);

        expect(serialised).not.toContain('hunter2');
        expect(serialised).not.toContain(secret);
    });

    it('does NOT leak err.stack into the response body', () => {
        const err = new Error('boom');
        // Force a distinctive stack marker we can grep for.
        err.stack =
            'Error: boom\n    at mySecretFunction (/srv/app/credentials.ts:42:13)';
        const ctx = fakeCtx('trace-stack');

        const { body } = toProblemResponse(err, ctx);
        const serialised = JSON.stringify(body);

        expect(serialised).not.toContain('mySecretFunction');
        expect(serialised).not.toContain('/srv/app/credentials.ts');
    });

    it('logs 500 branch at error level with the full message for on-call triage', () => {
        const err = new Error('transient db outage');
        const ctx = fakeCtx('trace-log');

        toProblemResponse(err, ctx);

        expect(ctx.logger.error).toHaveBeenCalledTimes(1);
        expect(ctx.logger.warn).not.toHaveBeenCalled();
        const [, fields] = ctx.logger.error.mock.calls[0] as [
            string,
            Record<string, unknown>,
        ];
        expect(fields).toMatchObject({
            traceId: 'trace-log',
            status: 500,
            errorName: 'Error',
            errorMessage: 'transient db outage',
        });
    });

    it('handles non-Error thrown values without crashing', () => {
        const ctx = fakeCtx('trace-nonerror');

        const { status, body } = toProblemResponse('just a string', ctx);

        expect(status).toBe(500);
        expect(body.status).toBe(500);
        expect(JSON.stringify(body)).not.toContain('just a string');
    });
});

/* ------------------------------------------------------------------ */
/*  registerErrorHandlers                                              */
/* ------------------------------------------------------------------ */

describe('registerErrorHandlers', () => {
    it('installs a single onError handler that emits application/problem+json', () => {
        // Minimal Hono-like fake: the handler passed to `onError` is
        // captured in a local so the test can invoke it directly.
        let captured:
            | ((err: unknown, c: ErrorHandlerContext) => Response)
            | undefined;
        const onErrorSpy = vi.fn(
            (handler: (err: unknown, c: ErrorHandlerContext) => Response) => {
                captured = handler;
                return undefined;
            },
        );
        const app: HonoLikeApp = {
            onError: onErrorSpy,
        };

        registerErrorHandlers(app);

        expect(onErrorSpy).toHaveBeenCalledTimes(1);
        expect(captured).toBeDefined();

        // Feed the captured handler a simulated request context and
        // assert the response shape.
        const traceId = 'trace-integ';
        const logger: ProblemLogger = {
            warn: vi.fn(),
            error: vi.fn(),
        };
        const bodySpy = vi.fn(
            (data: string, status: number, headers: Record<string, string>) => {
                return new Response(data, {
                    status,
                    headers,
                });
            },
        );

        // The context carries three overloaded `get` signatures
        // (`'traceId'` → string, `'logger'` → ProblemLogger,
        // `'authClaims'` → unknown). A single union-typed function
        // cannot satisfy all three overloads at once, so we build
        // the object via an `as` cast onto the narrowed dispatch
        // shape.
        const fakeCtxObj = {
            get(key: string): unknown {
                if (key === 'traceId') return traceId;
                if (key === 'logger') return logger;
                if (key === 'authClaims') return undefined;
                throw new Error(`unexpected key ${key}`);
            },
            body: bodySpy as ErrorHandlerContext['body'],
        } as unknown as ErrorHandlerContext;

        const response = captured!(new ValidationError('json', []), fakeCtxObj);

        expect(response).toBeInstanceOf(Response);
        expect(response.status).toBe(422);
        expect(response.headers.get('content-type')).toBe(
            PROBLEM_JSON_CONTENT_TYPE,
        );
        expect(bodySpy).toHaveBeenCalledTimes(1);
        const [dataArg, statusArg, headersArg] = bodySpy.mock.calls[0] as [
            string,
            number,
            Record<string, string>,
        ];
        expect(statusArg).toBe(422);
        expect(headersArg['content-type']).toBe(PROBLEM_JSON_CONTENT_TYPE);
        const parsed = JSON.parse(dataArg) as { traceId: string; status: number };
        expect(parsed.traceId).toBe(traceId);
        expect(parsed.status).toBe(422);
    });
});
