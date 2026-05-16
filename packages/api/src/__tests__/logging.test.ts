/**
 * Unit tests for the structured JSON logger.
 *
 * Covers the scenarios called out by task 13.5 acceptance:
 *   1. Each level writes to the correct `console` method as
 *      JSON-parseable output.
 *   2. `timestamp` is ISO-8601 (roundtripped through `Date.parse`).
 *   3. A base `traceId` flows through to every call.
 *   4. Per-call fields merge with base fields and win on collisions.
 *   5. `redactKeys` scrubs sensitive values, case-insensitively, and
 *      preserves everything else.
 *   6. A circular reference does not throw; the `[logger] JSON
 *      serialise failed` fallback fires on `console.error`.
 *   7. `null` / `undefined` field values serialise correctly —
 *      `undefined` keys are dropped, `null` is preserved.
 *
 * All assertions run against the real `console` spies; no module-
 * level mocks are needed because the logger only depends on
 * `console.{log, warn, error, debug}` and `Date`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_REDACTED_KEYS, createLogger, redactKeys } from '../logging.js';

import type { MockInstance } from 'vitest';

/** ISO-8601 with millisecond precision, as produced by `toISOString()`. */
const ISO_8601_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('createLogger', () => {
  let logSpy: MockInstance;
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;
  let debugSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Parse the first argument of the n-th spy call as JSON. */
  function parseCall(spy: MockInstance, callIndex = 0): Record<string, unknown> {
    const call = spy.mock.calls[callIndex] as unknown[] | undefined;
    expect(call, 'expected spy to have been called').toBeDefined();
    const first: unknown = call![0];
    expect(typeof first).toBe('string');
    return JSON.parse(first as string) as any;
  }

  it('routes info to console.log with JSON-parseable output', () => {
    const logger = createLogger();
    logger.info('hello');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = parseCall(logSpy);
    expect(payload.level).toBe('info');
    expect(payload.msg).toBe('hello');
  });

  it('routes warn to console.warn with JSON-parseable output', () => {
    const logger = createLogger();
    logger.warn('slow');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = parseCall(warnSpy);
    expect(payload.level).toBe('warn');
    expect(payload.msg).toBe('slow');
  });

  it('routes error to console.error with JSON-parseable output', () => {
    const logger = createLogger();
    logger.error('boom');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = parseCall(errorSpy);
    expect(payload.level).toBe('error');
    expect(payload.msg).toBe('boom');
  });

  it('routes debug to console.debug with JSON-parseable output', () => {
    const logger = createLogger();
    logger.debug('trace');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const payload = parseCall(debugSpy);
    expect(payload.level).toBe('debug');
    expect(payload.msg).toBe('trace');
  });

  it('emits an ISO-8601 UTC timestamp that roundtrips through Date.parse', () => {
    const logger = createLogger();
    logger.info('tick');

    const payload = parseCall(logSpy);
    expect(typeof payload.timestamp).toBe('string');
    expect(payload.timestamp as string).toMatch(ISO_8601_UTC_RE);
    // Roundtrip: parse and re-emit; ISO output must equal itself.
    const parsed = Date.parse(payload.timestamp as string);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(new Date(parsed).toISOString()).toBe(payload.timestamp);
  });

  it('carries the base traceId through every log call', () => {
    const logger = createLogger({ traceId: 'trace-abc' });
    logger.info('one');
    logger.warn('two');
    logger.error('three');
    logger.debug('four');

    expect(parseCall(logSpy).traceId).toBe('trace-abc');
    expect(parseCall(warnSpy).traceId).toBe('trace-abc');
    expect(parseCall(errorSpy).traceId).toBe('trace-abc');
    expect(parseCall(debugSpy).traceId).toBe('trace-abc');
  });

  it('merges per-call fields and lets them override base fields', () => {
    const logger = createLogger({ traceId: 'base-trace', env: 'prod' });
    logger.info('request', {
      method: 'POST',
      path: '/bookings',
      status: 201,
      durationMs: 17,
      // Override a base field on a single call.
      traceId: 'override-trace',
    });

    const payload = parseCall(logSpy);
    expect(payload.traceId).toBe('override-trace');
    expect(payload.env).toBe('prod');
    expect(payload.method).toBe('POST');
    expect(payload.path).toBe('/bookings');
    expect(payload.status).toBe(201);
    expect(payload.durationMs).toBe(17);
  });

  it('drops undefined field values and preserves null', () => {
    const logger = createLogger();
    logger.info('shape', {
      keptNull: null,
      droppedUndefined: undefined,
      keptZero: 0,
      keptFalse: false,
    });

    const payload = parseCall(logSpy);
    expect('droppedUndefined' in payload).toBe(false);
    expect(payload.keptNull).toBeNull();
    expect(payload.keptZero).toBe(0);
    expect(payload.keptFalse).toBe(false);
  });

  it('falls back to console.error without throwing when fields contain a circular reference', () => {
    const logger = createLogger({ traceId: 'trace-circular' });

    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => logger.info('will-cycle', { payload: circular })).not.toThrow();

    // The normal info() path produced no usable line.
    expect(logSpy).not.toHaveBeenCalled();

    // The fallback diagnostic ran on console.error.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const call = errorSpy.mock.calls[0] as unknown[] | undefined;
    expect(call).toBeDefined();
    expect(call![0]).toBe('[logger] JSON serialise failed');
  });
});

describe('redactKeys', () => {
  it('replaces default sensitive keys with the redacted placeholder', () => {
    const redact = redactKeys();
    const out = redact({
      password: 'hunter2',
      token: 'jwt.abc',
      authorization: 'Bearer xyz',
      stripeSignature: 't=1,v1=deadbeef',
      secret: 's3cret',
      userId: 'user-1',
    });

    expect(out.password).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.stripeSignature).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    // Non-sensitive keys pass through.
    expect(out.userId).toBe('user-1');
  });

  it('is case-insensitive on key names', () => {
    const redact = redactKeys(['Authorization']);
    const out = redact({ authorization: 'Bearer xyz', method: 'GET' });
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.method).toBe('GET');
  });

  it('accepts a custom key list and leaves defaults intact if not listed', () => {
    const redact = redactKeys(['apiKey']);
    const out = redact({ apiKey: 'k-1', password: 'still-here' });
    expect(out.apiKey).toBe('[REDACTED]');
    // Not in the custom list → unchanged.
    expect(out.password).toBe('still-here');
  });

  it('does not mutate the input record', () => {
    const redact = redactKeys();
    const input = { password: 'hunter2', userId: 'u-1' };
    const out = redact(input);
    expect(input.password).toBe('hunter2');
    expect(out).not.toBe(input);
  });

  it('exports the default key list as a readonly tuple', () => {
    expect(DEFAULT_REDACTED_KEYS).toContain('password');
    expect(DEFAULT_REDACTED_KEYS).toContain('token');
    expect(DEFAULT_REDACTED_KEYS).toContain('authorization');
    expect(DEFAULT_REDACTED_KEYS).toContain('stripeSignature');
  });
});
