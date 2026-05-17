/**
 * Trace / span id primitives — framework-free (task 8.6).
 *
 * Satisfies Requirements 14.5, 30.1, 30.2:
 *
 *   • 14.5 — The API_Gateway SHALL propagate the W3C `traceparent`
 *            header through every downstream call.
 *   • 30.1 — The API_Gateway SHALL emit an OpenTelemetry span for
 *            every incoming request.
 *   • 30.2 — The API_Gateway SHALL forward every emitted span to
 *            the OTLP endpoint (default: Axiom).
 *
 * This module owns the single source of truth for the four id
 * operations used across the gateway:
 *
 *   1. {@link extractTraceparentId} — extract the 32-hex trace-id
 *      from a W3C `traceparent` header. Returns `null` when the
 *      header is absent or malformed so callers can fall back to a
 *      generated id.
 *   2. {@link extractTraceparent} — same as above but also returns
 *      the 16-hex parent span-id, used by the OTel middleware to
 *      stitch child spans onto an inbound trace.
 *   3. {@link newTraceId} — fresh UUID v4 (with dashes). Used by
 *      `worker.ts` as the fallback identifier on the request
 *      context, preserving the pre-8.6 behaviour of the logging
 *      middleware.
 *   4. {@link newTraceIdHex} / {@link newSpanId} — 32-hex and 16-hex
 *      identifiers for OpenTelemetry span construction. Generated
 *      from `crypto.getRandomValues` so they carry full cryptographic
 *      entropy on every Worker isolate.
 *
 * Kept in its own module (rather than re-declared inside both
 * `worker.ts` and `middleware/otel.ts`) so the W3C regex and the
 * UUID-v4 fallback live in exactly one place. Duplicating either
 * would let the two call sites drift out of sync — a classic source
 * of correlation bugs between log lines and OTel spans.
 */

/* ------------------------------------------------------------------ */
/*  W3C traceparent                                                    */
/* ------------------------------------------------------------------ */

/**
 * Matches the four segments of a W3C `traceparent` header:
 *
 *   `version "-" trace-id "-" parent-id "-" trace-flags`
 *
 * Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`.
 *
 * Capture groups:
 *   • group 1 — 32-hex `trace-id`
 *   • group 2 — 16-hex `parent-id` (the span-id of the caller)
 *
 * Surrounding whitespace is tolerated — some proxies are known to
 * prepend a space on the header value and we do not want that
 * single byte to invalidate an otherwise-valid header.
 *
 * The regex is exported so test harnesses and debugging utilities
 * can reason about the exact shape we accept without reverse-
 * engineering it from the functions below.
 */
export const TRACEPARENT_RE = /^\s*[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}\s*$/u;

/**
 * Parsed `traceparent` pair, returned by {@link extractTraceparent}
 * on a valid header. `traceId` is 32 lowercase hex chars;
 * `parentSpanId` is 16 lowercase hex chars — the latter is the
 * caller's span-id, which becomes our span's `parentSpanId` when we
 * emit a child span on the same trace.
 */
export interface TraceparentFields {
  readonly traceId: string;
  readonly parentSpanId: string;
}

/**
 * Parse a W3C `traceparent` header value. Returns the trace-id /
 * parent-span-id pair on a valid match, `null` otherwise.
 *
 * `null` must be treated by the caller as "generate a fresh id" —
 * the helper deliberately does NOT throw on malformed input because
 * an externally-supplied header is untrusted data and a broken trace
 * must never fail the request.
 */
export function extractTraceparent(header: string | null): TraceparentFields | null {
  if (header === null) {
    return null;
  }
  const match = TRACEPARENT_RE.exec(header);
  if (match === null) {
    return null;
  }
  // Capture groups 1 and 2 are guaranteed non-null by the regex
  // shape above; the null-assertions keep TypeScript honest under
  // `noUncheckedIndexedAccess`.
  return {
    traceId: match[1]!,
    parentSpanId: match[2]!,
  };
}

/**
 * Extract only the 32-hex trace-id from a `traceparent` header.
 *
 * Thin wrapper over {@link extractTraceparent} kept for backwards
 * compatibility with task 8.1 — `worker.ts` only needs the trace-id
 * for its structured-logger scaffolding and does not participate in
 * OTel span construction.
 */
export function extractTraceparentId(header: string | null): string | null {
  return extractTraceparent(header)?.traceId ?? null;
}

/* ------------------------------------------------------------------ */
/*  UUID v4 — worker.ts trace-id fallback                              */
/* ------------------------------------------------------------------ */

/**
 * Generate a UUID v4 with dashes.
 *
 * Used by `worker.ts` (task 8.1) as the fallback identifier on the
 * request context when the inbound `traceparent` header is absent
 * or malformed. The UUID-with-dashes form is what the structured
 * logger emits on every log line, so existing log consumers that
 * key on the `traceId` field continue to see the same shape.
 *
 * Cloudflare Workers expose `crypto.randomUUID()` natively on every
 * runtime we support (the `nodejs_compat` flag is irrelevant —
 * `crypto` is a web-platform global). The conditional fallback keeps
 * the function importable on ancient Node test runners that do not
 * carry `crypto.randomUUID`.
 */
export function newTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  fillRandom(bytes);
  // RFC 4122 §4.4 — set version (4) and variant (10) bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ */
/*  OTel identifiers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Generate a 32-hex trace-id (no dashes) suitable for OpenTelemetry
 * span construction.
 *
 * OTel requires the trace-id to be 16 bytes rendered as 32
 * lowercase hex characters. We derive the value from
 * `crypto.getRandomValues` to match the entropy used by the inbound
 * `traceparent` header — any shortcut here would make the OTLP
 * exporter emit non-unique trace-ids under load.
 */
export function newTraceIdHex(): string {
  const bytes = new Uint8Array(16);
  fillRandom(bytes);
  return bytesToHex(bytes);
}

/**
 * Generate a 16-hex span-id.
 *
 * OTel requires the span-id to be 8 bytes rendered as 16 lowercase
 * hex characters. Generated via `crypto.getRandomValues` for the
 * same reason as {@link newTraceIdHex}.
 */
export function newSpanId(): string {
  const bytes = new Uint8Array(8);
  fillRandom(bytes);
  return bytesToHex(bytes);
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fill `buffer` with cryptographically-random bytes. Prefers
 * `crypto.getRandomValues` (Workers, modern Node, browsers); falls
 * back to `Math.random` only when that global is unavailable, which
 * in practice means a stripped-down test runner. The fallback path
 * is annotated so production deployments never land on it silently.
 */
function fillRandom(buffer: Uint8Array): void {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buffer);
    return;
  }
  // Defensive fallback — never taken on Workers. `Math.random` is
  // NOT cryptographically secure; we keep the fallback so the
  // helper is importable from any JS runtime, but production
  // isolates will always enter the branch above.
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
}

/** Lowercase hex encoding of the bytes. Stable across runtimes. */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
