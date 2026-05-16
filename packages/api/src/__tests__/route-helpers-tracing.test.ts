/**
 * Unit tests for `traceOperation` + `addBreadcrumb`
 * (Sprint 12 / Slices 12.9 + 12.10, Epics B7.3 + B7.2).
 *
 * Both helpers are pure no-ops when the OTel middleware is not
 * mounted (`c.get('span') === undefined`); when a span is present,
 * they must invoke `setName` / `addEvent` exactly once with the
 * documented payload shape.
 */

import { describe, expect, it, vi } from 'vitest';

import { addBreadcrumb, traceOperation } from '../routes/helpers.js';

import type { HonoEnv } from '../types.js';
import type { Context } from 'hono';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface FakeSpan {
  setName: ReturnType<typeof vi.fn>;
  addEvent: ReturnType<typeof vi.fn>;
}

function makeSpan(): FakeSpan {
  return {
    setName: vi.fn(),
    addEvent: vi.fn(),
  };
}

/** Build a Hono-compatible context exposing only `c.get(key)`. */
function makeCtx(span?: FakeSpan): Context<HonoEnv> {
  const map = new Map<string, unknown>();
  if (span !== undefined) map.set('span', span);
  return {
    get(key: string): unknown {
      return map.get(key);
    },
  } as unknown as Context;
}

/* ------------------------------------------------------------------ */
/*  traceOperation                                                     */
/* ------------------------------------------------------------------ */

describe('traceOperation', () => {
  it('is a no-op when the span variable is absent', () => {
    // Should not throw. Reaching here means the helper handled
    // the missing span gracefully.
    traceOperation(makeCtx(), 'auth.login');
  });

  it('calls span.setName with the operation name', () => {
    const span = makeSpan();
    traceOperation(makeCtx(span), 'auth.login');
    expect(span.setName).toHaveBeenCalledExactlyOnceWith('auth.login');
  });

  it('also stamps a breadcrumb.operation.start span event', () => {
    const span = makeSpan();
    traceOperation(makeCtx(span), 'reservations.book');
    expect(span.addEvent).toHaveBeenCalledExactlyOnceWith('breadcrumb.operation.start', {
      operation: 'reservations.book',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  addBreadcrumb                                                       */
/* ------------------------------------------------------------------ */

describe('addBreadcrumb', () => {
  it('is a no-op when the span variable is absent', () => {
    addBreadcrumb(makeCtx(), 'reservations.lock_acquired', {
      classId: 'c1',
    });
  });

  it('emits a breadcrumb.* span event with the supplied data', () => {
    const span = makeSpan();
    addBreadcrumb(makeCtx(span), 'reservations.lock_acquired', {
      classId: 'c1',
      remaining: 5,
    });
    expect(span.addEvent).toHaveBeenCalledExactlyOnceWith('breadcrumb.reservations.lock_acquired', {
      classId: 'c1',
      remaining: 5,
    });
  });

  it('emits a breadcrumb without data when none is supplied', () => {
    const span = makeSpan();
    addBreadcrumb(makeCtx(span), 'auth.login.success');
    expect(span.addEvent).toHaveBeenCalledExactlyOnceWith(
      'breadcrumb.auth.login.success',
      undefined,
    );
  });

  it('truncates oversized data (>1024 bytes JSON) to a placeholder', () => {
    const span = makeSpan();
    const largePayload: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) {
      largePayload[`key${String(i)}`] = `value-${String(i)}`.repeat(2);
    }

    addBreadcrumb(makeCtx(span), 'too.large', largePayload);

    expect(span.addEvent).toHaveBeenCalledTimes(1);
    const callArgs = span.addEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(callArgs[0]).toBe('breadcrumb.too.large');
    expect(callArgs[1].truncated).toBe(true);
    expect(typeof callArgs[1].bytes).toBe('number');
  });

  it('handles unserialisable data gracefully (circular reference)', () => {
    const span = makeSpan();
    const circular: { self?: unknown } = {};
    circular.self = circular;

    // Must not throw.
    addBreadcrumb(makeCtx(span), 'circular.test', circular);

    expect(span.addEvent).toHaveBeenCalledTimes(1);
    const callArgs = span.addEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(callArgs[0]).toBe('breadcrumb.circular.test');
    expect(callArgs[1].unserialisable).toBe(true);
  });
});
