/**
 * Unit tests for the SQLSTATE predicate helpers shipped in
 * `packages/db/src/errors.ts` (Slice B8.1).
 *
 * Validates: B8.1 (`tasks.md` lines 824 — Backend Hardening Epic
 * B8, sub-task "Extraire `isUniqueViolation` … dans un module
 * partagé `packages/db/src/errors.ts`").
 *
 * The predicates must:
 *
 *   1. Return `true` when the SQLSTATE appears at the top level
 *      (postgres-js raw error shape).
 *   2. Return `true` when the SQLSTATE appears nested inside the
 *      `.cause` chain (Drizzle wraps the raw error in
 *      `Failed query: …`, exposing the postgres-js error as
 *      `.cause`).
 *   3. Return `false` for other SQLSTATEs / non-error values /
 *      malformed inputs.
 *   4. Tolerate self-referential `cause` chains without infinite
 *      recursion (defensive against buggy wrappers).
 */

import { describe, it, expect } from 'vitest';

import {
  isPostgresUniqueViolation,
  isPostgresForeignKeyViolation,
  isPostgresCheckViolation,
  isPostgresSerializationFailure,
  isPostgresDeadlockDetected,
  isPostgresRaiseException,
} from '../src/errors.js';

describe('isPostgresUniqueViolation', () => {
  it('detects 23505 at the top level (raw postgres-js shape)', () => {
    expect(isPostgresUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('detects 23505 nested in `.cause` (Drizzle wrapper shape)', () => {
    const drizzleErr = new Error('Failed query: insert into …');
    (drizzleErr as { cause: unknown }).cause = { code: '23505' };
    expect(isPostgresUniqueViolation(drizzleErr)).toBe(true);
  });

  it('detects 23505 deeper in the chain (multi-level wrapping)', () => {
    const inner = { code: '23505' };
    const middle = new Error('middle');
    (middle as { cause: unknown }).cause = inner;
    const outer = new Error('outer');
    (outer as { cause: unknown }).cause = middle;
    expect(isPostgresUniqueViolation(outer)).toBe(true);
  });

  it('returns false for a different SQLSTATE', () => {
    expect(isPostgresUniqueViolation({ code: '23503' })).toBe(false);
  });

  it('returns false for null / undefined / primitive values', () => {
    expect(isPostgresUniqueViolation(null)).toBe(false);
    expect(isPostgresUniqueViolation(undefined)).toBe(false);
    expect(isPostgresUniqueViolation('23505')).toBe(false);
    expect(isPostgresUniqueViolation(23_505)).toBe(false);
  });

  it('does not loop on a self-referential cause chain', () => {
    const err: { code?: string; cause?: unknown } = { code: 'OTHER' };
    err.cause = err;
    // Predicate must terminate; result must be `false` because no
    // node carries 23505.
    expect(isPostgresUniqueViolation(err)).toBe(false);
  });
});

describe('isPostgresForeignKeyViolation', () => {
  it('detects 23503', () => {
    expect(isPostgresForeignKeyViolation({ code: '23503' })).toBe(true);
  });
  it('returns false for unique_violation', () => {
    expect(isPostgresForeignKeyViolation({ code: '23505' })).toBe(false);
  });
});

describe('isPostgresCheckViolation', () => {
  it('detects 23514 in `.cause`', () => {
    const wrapper = new Error('check failed');
    (wrapper as { cause: unknown }).cause = { code: '23514' };
    expect(isPostgresCheckViolation(wrapper)).toBe(true);
  });
});

describe('isPostgresSerializationFailure', () => {
  it('detects 40001', () => {
    expect(isPostgresSerializationFailure({ code: '40001' })).toBe(true);
  });
  it('returns false for deadlock 40P01', () => {
    expect(isPostgresSerializationFailure({ code: '40P01' })).toBe(false);
  });
});

describe('isPostgresDeadlockDetected', () => {
  it('detects 40P01', () => {
    expect(isPostgresDeadlockDetected({ code: '40P01' })).toBe(true);
  });
});

describe('isPostgresRaiseException', () => {
  it('detects P0001 at the top level', () => {
    expect(isPostgresRaiseException({ code: 'P0001' })).toBe(true);
  });

  it('matches message substring in the cause chain', () => {
    const wrapper = new Error('Failed query: insert into reservations');
    (wrapper as { cause: unknown }).cause = {
      code: 'P0001',
      message: 'class_capacity_exceeded',
    };
    expect(isPostgresRaiseException(wrapper, 'class_capacity_exceeded')).toBe(true);
  });

  it('returns false when message does not match', () => {
    expect(
      isPostgresRaiseException({ code: 'P0001', message: 'other' }, 'class_capacity_exceeded'),
    ).toBe(false);
  });
});
