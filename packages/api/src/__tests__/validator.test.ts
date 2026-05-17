/**
 * Unit tests for the Zod validation middleware (task 8.5).
 *
 * Scope:
 *   • Happy path — a valid body parses, the parsed value is written
 *     to `c.set('validated:<target>', parsed)`, control flows to
 *     `next()`.
 *   • Failure path — an invalid body causes the middleware to throw
 *     a {@link ValidationError} carrying `target` and `issues`. The
 *     middleware does NOT emit a response on its own (the global
 *     `onError` in `problem-details.ts` is the renderer).
 *   • All four targets are covered (`json`, `query`, `param`,
 *     `header`) so the readInput switch stays exhaustive.
 *
 * Validates: Requirements 14.2, 14.6.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ValidationError,
  validatedContextKey,
  zValidator,
  type ValidatorContext,
  type ValidatorRequest,
} from '../middleware/validator.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a fake {@link ValidatorContext} backed by vi mocks.
 *
 * Only the reader matching the target-under-test needs to return a
 * real value; the rest throw so a regression that wires the wrong
 * reader is caught loudly.
 */
function fakeContext(req: Partial<ValidatorRequest>): ValidatorContext & {
  setCalls: [string, unknown][];
} {
  const setCalls: [string, unknown][] = [];
  const fullReq: ValidatorRequest = {
    json: req.json ?? (() => Promise.reject(new Error('unexpected call to req.json()'))),
    query:
      req.query ??
      (() => {
        throw new Error('unexpected call to req.query()');
      }),
    param:
      req.param ??
      (() => {
        throw new Error('unexpected call to req.param()');
      }),
    header:
      req.header ??
      (() => {
        throw new Error('unexpected call to req.header()');
      }),
  };
  return {
    req: fullReq,
    set(key: string, value: unknown): void {
      setCalls.push([key, value]);
    },
    setCalls,
  };
}

/* ------------------------------------------------------------------ */
/*  Happy paths                                                        */
/* ------------------------------------------------------------------ */

describe('zValidator — happy path', () => {
  it('parses a valid JSON body and stores it under `validated:json`', async () => {
    const schema = z.object({
      email: z.email(),
      age: z.number().int().min(0),
    });

    const middleware = zValidator('json', schema);
    const c = fakeContext({
      json: () => Promise.resolve({ email: 'a@b.co', age: 30 }),
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c.setCalls).toEqual([['validated:json', { email: 'a@b.co', age: 30 }]]);
  });

  it('parses a valid query string and stores it under `validated:query`', async () => {
    const schema = z.object({ page: z.string().regex(/^\d+$/) });

    const middleware = zValidator('query', schema);
    const c = fakeContext({ query: () => ({ page: '3' }) });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c.setCalls).toEqual([['validated:query', { page: '3' }]]);
  });

  it('parses path params and stores them under `validated:param`', async () => {
    const schema = z.object({ id: z.uuid() });
    const id = '550e8400-e29b-41d4-a716-446655440000';

    const middleware = zValidator('param', schema);
    const c = fakeContext({ param: () => ({ id }) });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    expect(c.setCalls).toEqual([['validated:param', { id }]]);
  });

  it('parses headers and stores them under `validated:header`', async () => {
    const schema = z.object({
      'x-studio-slug': z.string().min(1),
    });

    const middleware = zValidator('header', schema);
    const c = fakeContext({
      header: () => ({ 'x-studio-slug': 'acme' }),
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(c, next);

    expect(c.setCalls).toEqual([['validated:header', { 'x-studio-slug': 'acme' }]]);
  });

  it('exposes the context key via validatedContextKey for every target', () => {
    expect(validatedContextKey('json')).toBe('validated:json');
    expect(validatedContextKey('query')).toBe('validated:query');
    expect(validatedContextKey('param')).toBe('validated:param');
    expect(validatedContextKey('header')).toBe('validated:header');
  });
});

/* ------------------------------------------------------------------ */
/*  Failure paths                                                      */
/* ------------------------------------------------------------------ */

describe('zValidator — failure path', () => {
  it('throws ValidationError carrying target and issues on an invalid JSON body', async () => {
    const schema = z.object({
      email: z.email(),
      age: z.number().int().min(18),
    });

    const middleware = zValidator('json', schema);
    const c = fakeContext({
      json: () => Promise.resolve({ email: 'not-an-email', age: 10 }),
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(middleware(c, next)).rejects.toBeInstanceOf(ValidationError);
    expect(next).not.toHaveBeenCalled();
    expect(c.setCalls).toEqual([]);

    // Re-run to capture the error for field inspection.
    let captured: unknown;
    try {
      await middleware(c, next);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ValidationError);
    const err = captured as ValidationError;
    expect(err.target).toBe('json');
    expect(err.code).toBe('validation_error');
    expect(err.name).toBe('ValidationError');
    expect(Array.isArray(err.issues)).toBe(true);
    expect(err.issues.length).toBeGreaterThan(0);
    // Two expected failures: email format, age < 18.
    const codes = err.issues.map((i) => i.code);
    expect(codes.length).toBe(2);
    // Paths should target the two invalid fields.
    const paths = err.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('email');
    expect(paths).toContain('age');
  });

  it('throws ValidationError with target `query` when the query string fails', async () => {
    const schema = z.object({ page: z.string().regex(/^\d+$/) });

    const middleware = zValidator('query', schema);
    const c = fakeContext({ query: () => ({ page: 'not-a-number' }) });
    const next = vi.fn().mockResolvedValue(undefined);

    let captured: unknown;
    try {
      await middleware(c, next);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ValidationError);
    expect((captured as ValidationError).target).toBe('query');
    expect(next).not.toHaveBeenCalled();
  });

  it('preserves the prototype chain so `instanceof ValidationError` works across module boundaries', () => {
    const err = new ValidationError('json', []);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toBeInstanceOf(Error);
  });
});
