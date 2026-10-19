/**
 * Framework-free structured JSON logger for Cloudflare Workers.
 *
 * Satisfies Requirement 30.4:
 *
 *   "THE Athlya_Platform SHALL log every request in structured JSON
 *    containing at minimum `timestamp`, `traceId`, `method`, `path`,
 *    `status` and `durationMs`."
 *
 * Design notes
 * ------------
 * • Workers expose no Node streams. `console.log` / `console.warn` /
 *   `console.error` are the documented sink routed to the Cloudflare
 *   observability pipeline (Tail Workers / Logpush), so that is what
 *   we emit on — no `process.stdout`, no external SDK.
 *
 * • This module is framework-agnostic. The Hono gateway (task 8.1)
 *   will wrap it with per-request middleware that fills in the
 *   `{ method, path, status, durationMs }` fields, but the logger
 *   itself must not depend on Hono, OpenTelemetry or any runtime-
 *   specific global so it can be reused from queue consumers,
 *   scheduled handlers and Durable Objects.
 *
 * • `createLogger({ traceId })` returns a child-style logger that
 *   carries the base fields through every call. Per-call fields
 *   override base fields with the same key — useful for
 *   `logger.info('served', { status: 200, durationMs: 42 })` once
 *   the response is known.
 *
 * • `redactKeys` walks a `LogFields` record and replaces sensitive
 *   values with `'[REDACTED]'`. The default list covers the obvious
 *   suspects (`password`, `token`, `refreshToken`, `accessToken`,
 *   `idToken`, `authorization`, `cookie`, `stripeSignature`) plus a
 *   common-case `secret`. Callers are expected to pre-redact
 *   untrusted payload shapes before passing them to a log call; this
 *   utility keeps the surface explicit rather than trying to walk
 *   arbitrary object graphs automatically.
 *
 * • Serialisation errors must not crash the Worker. Circular
 *   references, BigInt values or getters that throw are all
 *   possible in real traffic. `safeStringify` swallows every failure
 *   and emits a fallback log through `console.error` so on-call
 *   engineers can still see that something tried to log.
 */

/** Severity levels accepted by {@link StructuredLogger}. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Extensible bag of log fields.
 *
 * The six fields named in Requirement 30.4 are declared explicitly so
 * TypeScript helps the caller wire them correctly; the index signature
 * keeps the type open so callers can add domain-specific context
 * (e.g. `tenantId`, `userId`, `eventId`, `idempotencyKey`) without a
 * fresh type definition.
 */
export interface LogFields {
  traceId?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

/** Minimal logger surface. One method per {@link LogLevel}. */
export interface StructuredLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/**
 * Keys whose values are scrubbed by {@link redactKeys} when no
 * override list is supplied. Kept as a `readonly` tuple so consumers
 * can spread it (`redactKeys([...DEFAULT_REDACTED_KEYS, 'apiKey'])`).
 */
export const DEFAULT_REDACTED_KEYS: readonly string[] = Object.freeze([
  'password',
  'token',
  // Matching is on the whole key, so `token` does not cover these
  // (audit S2-012: refresh tokens travel in JSON bodies).
  'refreshToken',
  'accessToken',
  'idToken',
  'authorization',
  'cookie',
  'stripeSignature',
  'secret',
]);

/** Placeholder value used to replace redacted field contents. */
const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Produce a field-mapping function that replaces values of any key in
 * `keys` with `'[REDACTED]'`. Keys outside the list pass through
 * untouched; the input record is never mutated.
 *
 * Matching is case-insensitive so `Authorization` and `authorization`
 * both get scrubbed — useful when fields come from raw HTTP headers.
 */
export function redactKeys(
  keys: readonly string[] = DEFAULT_REDACTED_KEYS,
): (fields: LogFields) => LogFields {
  const lowered = new Set(keys.map((k) => k.toLowerCase()));
  return (fields) => {
    const out: LogFields = Object.create(null) as LogFields;
    for (const [k, v] of Object.entries(fields)) {
      out[k] = lowered.has(k.toLowerCase()) ? REDACTED_PLACEHOLDER : v;
    }
    return out;
  };
}

/**
 * Create a logger that emits one JSON line per call. Shape:
 *
 *   { timestamp, level, msg, ...baseFields, ...fields }
 *
 * where `timestamp` is an ISO-8601 UTC string produced by
 * `new Date().toISOString()`. Per-call fields override base fields
 * of the same name — the child-field wins.
 *
 * Sprint-3 Slice 3.2 (Vague 31, audit finding S5-008) — every emit
 * now passes BOTH `baseFields` and the per-call `fields` through
 * the `redactKeys(DEFAULT_REDACTED_KEYS)` filter so values keyed on
 * `password`, `token`, `authorization`, `stripeSignature`, `secret`
 * (case-insensitive) are replaced with `'[REDACTED]'` before
 * serialisation. The audit flagged that the helper was exported but
 * never wired — consumers had to opt in field-by-field, which is
 * unsafe by default and broken by every future PR that forgets the
 * call. Auto-redaction makes the safer path the easier path.
 *
 * Callers that need a custom redaction list can still call
 * {@link redactKeys} explicitly and merge the result into their
 * fields parameter — the auto-redaction is additive, not exclusive.
 *
 * The logger routes each level to the matching `console` method:
 *
 *   • `debug` → `console.debug`
 *   • `info`  → `console.log`   (Workers treats `log` as the default sink)
 *   • `warn`  → `console.warn`
 *   • `error` → `console.error`
 */
export function createLogger(
  base: { traceId?: string; [key: string]: unknown } = {},
): StructuredLogger {
  const baseFields = { ...base };
  // Pre-build the redactor once so each emit is allocation-free
  // beyond the per-call fields traversal. The filter walks the
  // entries shallowly — matching what `redactKeys` documents.
  const redact = redactKeys(DEFAULT_REDACTED_KEYS);

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    // Sprint-3 SP3.2 (S5-008): auto-redact the merged field map
    // BEFORE serialisation. Both base + per-call entries flow
    // through `redact` so a stale `createLogger({ token: ... })`
    // call (defensive — nothing in the codebase does this today)
    // also gets scrubbed.
    const merged: LogFields = {
      ...baseFields,
      ...(fields ?? {}),
    };
    const redacted = redact(merged);
    // `undefined` values are dropped by JSON.stringify, matching
    // the documented behaviour ("undefined keys dropped"). We let
    // the stringifier do that work rather than pre-filtering, which
    // keeps the logger's hot path allocation-light.
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...redacted,
    };

    const line = safeStringify(payload);
    if (line === null) {
      // safeStringify already logged the fallback error; nothing
      // more to do — we must not throw from a log call.
      return;
    }

    switch (level) {
      case 'debug':
        console.debug(line);
        return;
      case 'info':
        console.log(line);
        return;
      case 'warn':
        console.warn(line);
        return;
      case 'error':
        console.error(line);
        return;
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

/**
 * `JSON.stringify` that never throws.
 *
 * Returns the serialised string, or `null` when serialisation failed.
 * On failure, logs a diagnostic line through `console.error` so the
 * dropped event is still visible to operators.
 */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch (err) {
    // Last-ditch fallback: surface the failure on stderr so the
    // loss is observable, then swallow so callers never see an
    // exception from a log call.
    try {
      const description = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      // Best-effort stringification of the offending payload for
      // triage. `String(value)` returns `'[object Object]'` for
      // plain records, which is not informative but is at least
      // safe — it never throws.
      console.error('[logger] JSON serialise failed', description, String(value));
    } catch {
      // If even console.error throws (it shouldn't, but we are
      // defensive on edge runtimes), there is nothing more to do.
    }
    return null;
  }
}
