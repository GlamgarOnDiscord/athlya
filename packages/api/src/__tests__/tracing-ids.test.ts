/**
 * Unit tests for the shared tracing-id helpers (task 8.6).
 *
 * Scope:
 *   • `extractTraceparentId` — happy path, malformed header, null.
 *   • `extractTraceparent` — parses both the trace-id and the
 *     parent-span-id on a valid header.
 *   • `newTraceId` — matches the UUID v4 shape the logger has always
 *     emitted (backward-compat guarantee for task 8.1 log consumers).
 *   • `newTraceIdHex` / `newSpanId` — emit exactly 32 / 16 hex chars.
 *
 * Validates: Requirements 14.5, 30.1, 30.2.
 */

import { describe, expect, it } from 'vitest';

import {
  extractTraceparent,
  extractTraceparentId,
  newSpanId,
  newTraceId,
  newTraceIdHex,
} from '../tracing/ids.js';

/** Regex matching a UUID v4 with dashes, as `crypto.randomUUID()` emits. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const HEX_32_RE = /^[0-9a-f]{32}$/u;
const HEX_16_RE = /^[0-9a-f]{16}$/u;

describe('extractTraceparentId', () => {
  it('returns the 32-hex trace-id on a valid traceparent header', () => {
    const traceId = 'abcdef0123456789abcdef0123456789';
    const parentId = '0123456789abcdef';
    const header = `00-${traceId}-${parentId}-01`;
    expect(extractTraceparentId(header)).toBe(traceId);
  });

  it('tolerates surrounding whitespace added by proxies', () => {
    const traceId = 'abcdef0123456789abcdef0123456789';
    const header = `  00-${traceId}-0123456789abcdef-01  `;
    expect(extractTraceparentId(header)).toBe(traceId);
  });

  it('returns null on a malformed header', () => {
    expect(extractTraceparentId('not-a-real-header')).toBeNull();
  });

  it('returns null when the header is absent', () => {
    expect(extractTraceparentId(null)).toBeNull();
  });

  it('rejects headers with an invalid segment length', () => {
    // trace-id is only 31 hex chars here.
    const header = '00-abcdef0123456789abcdef012345678-0123456789abcdef-01';
    expect(extractTraceparentId(header)).toBeNull();
  });
});

describe('extractTraceparent', () => {
  it('returns both the trace-id and the parent-span-id on a valid header', () => {
    const traceId = 'abcdef0123456789abcdef0123456789';
    const parentId = '0123456789abcdef';
    const header = `00-${traceId}-${parentId}-01`;
    expect(extractTraceparent(header)).toEqual({
      traceId,
      parentSpanId: parentId,
    });
  });

  it('returns null on a malformed header', () => {
    expect(extractTraceparent('00-foo-bar-01')).toBeNull();
  });
});

describe('newTraceId', () => {
  it('emits a UUID v4 with dashes, backwards-compatible with task 8.1', () => {
    const id = newTraceId();
    expect(id).toMatch(UUID_V4_RE);
  });

  it('emits a fresh value on every call', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
  });
});

describe('newTraceIdHex', () => {
  it('emits exactly 32 lowercase hex characters', () => {
    expect(newTraceIdHex()).toMatch(HEX_32_RE);
  });

  it('emits a fresh value on every call', () => {
    expect(newTraceIdHex()).not.toBe(newTraceIdHex());
  });
});

describe('newSpanId', () => {
  it('emits exactly 16 lowercase hex characters', () => {
    expect(newSpanId()).toMatch(HEX_16_RE);
  });

  it('emits a fresh value on every call', () => {
    expect(newSpanId()).not.toBe(newSpanId());
  });
});
