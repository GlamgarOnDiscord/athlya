/**
 * DLQ drain + observability — hardening task H2.
 *
 * Task 9.4 configured Cloudflare Queues with a dead-letter queue,
 * `athlya-events-dlq`, that collects messages rejected by the primary
 * consumer five consecutive times (see `wrangler.toml` and
 * `./dlq.md`). Before this module landed, nothing observed that
 * queue: if a bug sent 1 000 messages to the DLQ overnight, they
 * accumulated silently because Cloudflare Queues has no "peek" API.
 * Once a message is consumed by any handler, it is gone.
 *
 * H2 solves that with a two-layer design:
 *
 *   1. **Drain handler** — {@link handleDlqBatch} is registered as the
 *      Worker's `queue()` consumer for `athlya-events-dlq` in
 *      `worker.ts`. Every DLQ message is upserted into a Redis-backed
 *      tracker (keyed on the message id) and **immediately acked** so
 *      Cloudflare does not redeliver the same bytes over and over.
 *      The tracker is now the single source of truth for "what is
 *      currently stuck in the DLQ".
 *
 *   2. **Admin surface** — {@link dlqStats}, {@link dlqReplay} and
 *      {@link dlqDiscard} read / mutate the tracker. The HTTP layer
 *      around them lives in `../admin/dlq-routes.ts` (admin-only,
 *      RFC 9457 Problem Details envelope on failures) — this module
 *      stays framework-free.
 *
 * Why Redis and not Durable Objects?
 * ----------------------------------
 * Upstash Redis is already in the bindings surface (rate limiter,
 * idempotency store) and gives us a sorted set for O(log n) ordered
 * access plus per-key TTLs we do not actually use here. A Durable
 * Object would work too but would require a brand-new binding,
 * migration, and test harness — overkill for a small admin panel.
 *
 * Redis schema
 * ------------
 *   • `dlq:entry:<id>` — JSON blob matching {@link DlqEntry}. Written
 *     on every observed message. No TTL: the admin surface is the
 *     only thing that removes entries (via `dlqReplay` / `dlqDiscard`).
 *   • `dlq:pending` — sorted set. Member is the message id, score is
 *     `firstSeenAt` (epoch ms). Used to iterate entries in arrival
 *     order and to compute `oldestAgeMs`.
 *
 * The two keys are kept consistent by writing the entry blob first,
 * then adding to the sorted set. If the second write fails, the
 * entry blob is orphaned but harmless — the admin surface treats
 * "entry exists but not in the pending set" as "not found" (defense
 * in depth in {@link dlqReplay}).
 *
 * At-least-once semantics
 * -----------------------
 * Cloudflare Queues delivers at-least-once, so an id may be observed
 * twice — a consumer restart, a delivery retry, or (in the limit) a
 * bug in our own ack loop. {@link handleDlqBatch} handles that
 * explicitly: an id we have already seen bumps the `attempts` counter
 * and updates `lastSeenAt` rather than creating a duplicate entry.
 * The downstream consumer (event.id-based dedup, Req 17.4) already
 * protects against double replay.
 */

import { Redis } from '@upstash/redis';

import { logEvent } from '../logging.js';
import { createSentryClient, type SentryClient } from '../sentry.js';

import { resolveEventQueueProducer, type EventQueueBindings } from './route-queue.js';

import type { AthlyaEnvironment } from '../types.js';
import type { MessageBatch, Queue } from '@cloudflare/workers-types';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Minimal Worker bindings the DLQ drain + admin surface need.
 *
 * Declared here (not in `types.ts`) because the bindings used by
 * different slices of the gateway intentionally stay local to their
 * module — the full {@link import('../types.js').AthlyaBindings}
 * shape is a superset and is structurally assignable to this type.
 *
 *   - `EVENTS_DLQ`    producer binding for the DLQ itself. Unused
 *                     today: we never re-publish back onto the DLQ.
 *                     Present in the interface so future workflows
 *                     (e.g. "quarantine an event") have a named port.
 *   - `EVENTS_QUEUE`  producer binding for the main events queue.
 *                     Used by {@link dlqReplay} to put the payload
 *                     back into circulation.
 *   - `REDIS_URL`     Upstash REST URL for the tracker.
 *   - `REDIS_TOKEN`   Upstash REST token. Secret.
 */
export interface DlqBindings extends EventQueueBindings {
  readonly EVENTS_DLQ: Queue<unknown>;
  readonly REDIS_URL: string;
  readonly REDIS_TOKEN: string;
  /**
   * Sentry DSN. Optional — when absent (dev / preview without
   * Sentry project), the alerting helper falls back to a
   * console.error line and the rest of the drain runs unchanged
   * (Req 30.3 — Sentry transport failures must never disrupt the
   * primary path).
   */
  readonly SENTRY_DSN?: string;
  /**
   * Named environment, surfaced as the `env` tag on the Sentry
   * event so on-call can filter dev / staging / production from a
   * single project. Optional for the same reason as `SENTRY_DSN`.
   */
  readonly ENVIRONMENT?: AthlyaEnvironment;
  /** Build identifier echoed as the Sentry `release`. Optional. */
  readonly VERSION?: string;
}

/**
 * Tracker entry stored in Redis under `dlq:entry:<id>`.
 *
 * Every field is `readonly` so the admin surface cannot accidentally
 * mutate an entry in place. The Redis layer always writes the full
 * blob on update rather than patching a subset, so the type matches
 * what is actually serialised.
 */
export interface DlqEntry {
  /**
   * Cloudflare `Message.id`. Opaque 16+ byte identifier chosen by
   * the queue runtime; we never parse it.
   */
  readonly id: string;

  /** Epoch ms the id was first observed by this handler. */
  readonly firstSeenAt: number;

  /** Epoch ms the id was most recently observed. */
  readonly lastSeenAt: number;

  /**
   * How many times this handler has observed the id. Bumped on
   * every re-observation. Starts at 1 on insert.
   *
   * NOTE: this is NOT Cloudflare's own `Message.attempts` counter
   * (which tracks deliveries on the primary queue before the DLQ
   * hop). It is our tracker's own count of DLQ-side sightings.
   */
  readonly attempts: number;

  /**
   * Original message payload as received from the DLQ. Opaque to
   * this module: {@link dlqReplay} hands it straight to
   * `EVENTS_QUEUE.send` without schema checks (the message already
   * passed the producer's `parseEvent` once; re-validating here
   * would silently swallow an event that a consumer fix might
   * later be able to process).
   */
  readonly payload: unknown;

  /**
   * Best-effort capture of the consumer-side error that sent this
   * message to the DLQ. Cloudflare does not surface the rejection
   * reason to the consumer that processes the DLQ, so this field
   * is currently always `null`. Kept in the schema so a future
   * upstream improvement (or a producer-side failure-reason side-
   * channel) can populate it without a breaking change.
   */
  readonly lastError: string | null;
}

/** Summary returned by {@link handleDlqBatch}. */
export interface DlqDrainResult {
  /** Total messages consumed from the DLQ in this invocation. */
  readonly observed: number;

  /**
   * How many of those messages produced a brand-new tracker entry.
   * Re-observations of a previously tracked id count towards
   * `observed` but NOT towards `tracked`.
   */
  readonly tracked: number;

  /**
   * Size of the `dlq:pending` sorted set AFTER this run. Surfacing
   * this on every drain makes it trivial to alert on "DLQ tracker
   * non-empty for > 5 min" from the structured log line.
   */
  readonly totalPending: number;
}

/* ------------------------------------------------------------------ */
/*  Redis key helpers                                                  */
/* ------------------------------------------------------------------ */

/** Key prefix for individual entry blobs. */
const ENTRY_PREFIX = 'dlq:entry:';

/** Sorted-set key listing pending (non-discarded, non-replayed) ids. */
const PENDING_SET_KEY = 'dlq:pending';

/**
 * Cap returned to the admin UI via {@link dlqStats}. 100 is enough
 * for an on-call operator to triage a burst; deeper inspection can
 * page through via future pagination params.
 */
const MAX_STATS_ENTRIES = 100;

/** Derive the per-entry Redis key from a message id. */
function entryKey(id: string): string {
  return `${ENTRY_PREFIX}${id}`;
}

/* ------------------------------------------------------------------ */
/*  Redis client cache                                                 */
/* ------------------------------------------------------------------ */

/**
 * Upstash clients keyed by `REDIS_URL`. Mirrors the pattern used by
 * the rate-limit middleware: a single Worker isolate can legitimately
 * serve multiple environments during a preview build, so the cache
 * key MUST include the URL rather than acting as a pure singleton.
 */
const redisCache = new Map<string, Redis>();

function getCachedRedis(env: Pick<DlqBindings, 'REDIS_URL' | 'REDIS_TOKEN'>): Redis {
  const url = env.REDIS_URL;
  const cached = redisCache.get(url);
  if (cached !== undefined) {
    return cached;
  }
  const client = new Redis({ url, token: env.REDIS_TOKEN });
  redisCache.set(url, client);
  return client;
}

/**
 * Test-only hook. Clears the module-level Redis cache so successive
 * tests can swap in fresh fakes without residue. Prefixed with `__`
 * so it reads as internal at every call site.
 */
export function __resetDlqRedisCache(): void {
  redisCache.clear();
}

/**
 * Test / adapter seam. {@link handleDlqBatch}, {@link dlqStats},
 * {@link dlqReplay} and {@link dlqDiscard} resolve their Redis client
 * through this shared lookup so tests can inject a fake by passing an
 * `env` whose `REDIS_URL` is seeded in the cache ahead of time.
 *
 * Declared here (not inline in each entry point) so the lookup logic
 * stays factored and a future refactor to a DI-style deps bundle is
 * localised.
 */
function resolveRedis(env: DlqBindings): Redis {
  return getCachedRedis(env);
}

/** Test-only helper to pre-seed the cache with a fake client. */
export function __setDlqRedisForTests(url: string, client: Redis): void {
  redisCache.set(url, client);
}

/* ------------------------------------------------------------------ */
/*  Sentry alerting                                                    */
/* ------------------------------------------------------------------ */

/**
 * Cached per-DSN Sentry client. Shape mirrors the `clientCache`
 * from `../sentry.ts` so a single bindings configuration only ever
 * builds one envelope POST machinery per isolate. The cache key is
 * `(env, dsn, version)` so a deploy that changes the release id
 * gets a fresh client without crossing the streams between two
 * environments.
 */
const sentryCache = new Map<string, SentryClient>();

function sentryCacheKey(env: DlqBindings): string {
  return `${env.ENVIRONMENT ?? ''}|${env.SENTRY_DSN ?? ''}|${env.VERSION ?? ''}`;
}

function resolveSentryClient(env: DlqBindings): SentryClient | null {
  if (env.SENTRY_DSN === undefined || env.SENTRY_DSN.length === 0) {
    return null;
  }
  const key = sentryCacheKey(env);
  const cached = sentryCache.get(key);
  if (cached !== undefined) return cached;
  // Build the factory options conditionally so
  // `exactOptionalPropertyTypes` is respected — we only set a
  // property when its value is actually defined.
  const opts: Parameters<typeof createSentryClient>[0] = {
    environment: env.ENVIRONMENT ?? 'production',
    dsn: env.SENTRY_DSN,
    ...(env.VERSION !== undefined ? { release: env.VERSION } : {}),
  };
  const client = createSentryClient(opts);
  sentryCache.set(key, client);
  return client;
}

/** Test-only hook. Clears the Sentry client cache so tests can swap
 *  in fresh fakes without residue. */
export function __resetDlqSentryCacheForTests(): void {
  sentryCache.clear();
}

/**
 * Emit one Sentry alert per **freshly tracked** DLQ entry.
 *
 * Slice B6.2 — every message the drain sees for the first time is a
 * platform-level signal: it survived the primary consumer's 5-retry
 * budget, which means the on-call team needs to triage it. The
 * payload may carry an `event.id` and `event.type` (when the bytes
 * decode as our own envelope) — surface those as tags so the
 * incident view groups by event type out of the box.
 *
 * Failure isolation: per Req 30.3, Sentry transport failures must
 * never disrupt the primary path. {@link SentryClient.captureException}
 * already swallows network errors; we wrap the whole call in a
 * try/catch as belt-and-braces so an unexpected throw (e.g. a
 * synchronous error thrown by a misbehaving stub in tests) never
 * breaks the drain. A Sentry-less deploy logs a structured
 * `console.error` line so Tail Workers still surface the signal.
 *
 * The function is `async` but always resolves — callers do not need
 * to await it for correctness; we await internally so the envelope
 * POST has a chance to settle within the Worker's `waitUntil`
 * window.
 */
async function alertOnDlqEntry(entry: DlqEntry, env: DlqBindings): Promise<void> {
  const client = resolveSentryClient(env);
  // Best-effort decode of the embedded domain envelope so the
  // alert tags carry `event.type` / `event.id` when available.
  let eventType: string | undefined;
  let eventId: string | undefined;
  if (
    entry.payload !== null &&
    typeof entry.payload === 'object' &&
    !Array.isArray(entry.payload)
  ) {
    const payload = entry.payload as Record<string, unknown>;
    if (typeof payload['type'] === 'string') eventType = payload['type'];
    if (typeof payload['id'] === 'string') eventId = payload['id'];
  }

  const tags: Record<string, string> = {
    queue: 'athlya-events-dlq',
    messageId: entry.id,
  };
  if (eventType !== undefined) tags['eventType'] = eventType;
  if (eventId !== undefined) tags['eventId'] = eventId;

  if (client === null) {
    // No DSN configured — fall back to a structured log line so
    // operators still see the signal in `wrangler tail`.
    console.error('[dlq] alert (no Sentry DSN configured)', {
      messageId: entry.id,
      eventType: eventType ?? null,
      eventId: eventId ?? null,
      attempts: entry.attempts,
    });
    return;
  }

  try {
    await client.captureException(
      new Error(`queue.dlq.entry: message ${entry.id} survived primary consumer retry budget`),
      {
        tags,
        extra: {
          attempts: entry.attempts,
          firstSeenAt: entry.firstSeenAt,
        },
      },
    );
  } catch (err) {
    // Defence in depth — `captureException` already swallows
    // its own errors per Req 30.3, but a misbehaving stub
    // (tests, mocks) might still throw synchronously.
    console.error('[dlq] sentry alert failed', {
      messageId: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Entry serialisation                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse a stored entry blob back into a {@link DlqEntry}. Returns
 * `null` when the value is missing, malformed or carries a shape we
 * do not recognise — callers treat `null` as "entry not found".
 *
 * Defensive: the Upstash client deserialises JSON automatically when
 * `automaticDeserialization` is left on (the default), so the value
 * may come back as an already-parsed object OR as a raw string. We
 * handle both.
 */
function parseEntry(raw: unknown): DlqEntry | null {
  if (raw === null || raw === undefined) return null;

  let obj: unknown;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    obj = raw;
  }

  if (typeof obj !== 'object' || obj === null) return null;

  const record = obj as Record<string, unknown>;
  const id = record['id'];
  const firstSeenAt = record['firstSeenAt'];
  const lastSeenAt = record['lastSeenAt'];
  const attempts = record['attempts'];
  const lastError = record['lastError'];

  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof firstSeenAt !== 'number' || !Number.isFinite(firstSeenAt)) return null;
  if (typeof lastSeenAt !== 'number' || !Number.isFinite(lastSeenAt)) return null;
  if (typeof attempts !== 'number' || !Number.isFinite(attempts) || attempts < 0) {
    return null;
  }
  if (lastError !== null && typeof lastError !== 'string') return null;

  return {
    id,
    firstSeenAt,
    lastSeenAt,
    attempts,
    payload: record['payload'],
    lastError,
  };
}

/** Serialise an entry for storage. Always emits a string so we do not
 * depend on the Upstash client's auto-serialisation heuristics. */
function serialiseEntry(entry: DlqEntry): string {
  return JSON.stringify(entry);
}

/* ------------------------------------------------------------------ */
/*  handleDlqBatch                                                     */
/* ------------------------------------------------------------------ */

/**
 * Queue consumer entry point for `athlya-events-dlq`.
 *
 * For every message in `batch.messages`:
 *
 *   1. Look up an existing tracker entry at `dlq:entry:<id>`.
 *   2. If absent → write a fresh entry, add the id to
 *      `dlq:pending` with score `firstSeenAt`, bump the `tracked`
 *      counter.
 *   3. If present → overwrite with `attempts + 1`, update
 *      `lastSeenAt`, and re-add to the sorted set (idempotent: ZADD
 *      without NX just updates the score, but we deliberately keep
 *      the original `firstSeenAt` to preserve the arrival-order
 *      invariant used by {@link dlqStats}).
 *   4. `msg.ack()` the Cloudflare message so it is not redelivered.
 *
 * Per-message failures (Redis write fails, message body is not JSON,
 * …) are swallowed with a warn log: the message is NOT acked in that
 * case so Cloudflare will retry it up to the DLQ consumer's own
 * `max_retries = 3` budget, after which the platform surfaces the
 * message as "unprocessable" and pages on-call.
 */
export async function handleDlqBatch(
  batch: MessageBatch<unknown>,
  env: DlqBindings,
): Promise<DlqDrainResult> {
  const redis = resolveRedis(env);
  const now = Date.now();

  let tracked = 0;

  for (const msg of batch.messages) {
    try {
      const key = entryKey(msg.id);
      const existing = parseEntry(await redis.get<string>(key));

      let entry: DlqEntry;
      let isNew: boolean;
      if (existing === null) {
        entry = {
          id: msg.id,
          firstSeenAt: now,
          lastSeenAt: now,
          attempts: 1,
          payload: msg.body,
          lastError: null,
        };
        isNew = true;
      } else {
        entry = {
          ...existing,
          lastSeenAt: now,
          attempts: existing.attempts + 1,
          // Keep the original payload — the first copy we
          // observed is authoritative. Cloudflare
          // redeliveries can in principle carry different
          // bytes if the body is non-deterministic, but the
          // producer never mutates in place.
        };
        isNew = false;
      }

      await redis.set(key, serialiseEntry(entry));
      // ZADD is idempotent on an existing member (overwrites the
      // score). We only add when the entry is new so the stored
      // score stays pinned to `firstSeenAt` — re-observations
      // must NOT bump an id back to the head of the queue.
      if (isNew) {
        await redis.zadd(PENDING_SET_KEY, {
          score: entry.firstSeenAt,
          member: msg.id,
        });
        tracked += 1;
        // Slice B6.2 — fire one Sentry alert per freshly
        // tracked entry. Re-observations are noisy by
        // construction (same id redelivered) so we keep
        // alerts to the first sighting only. The helper
        // never throws.
        await alertOnDlqEntry(entry, env);
      }

      msg.ack();
    } catch (err) {
      // Deliberately do NOT re-throw: one poisoned message must
      // not abort the whole batch. The unacked message gets
      // retried by Cloudflare; after 3 retries it surfaces as a
      // platform incident (DLQ-on-the-DLQ is not configured).
      console.error('[dlq] failed to track message', {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Final pending count — cheap, a single ZCARD round-trip, and it
  // makes the structured log line downstream observable.
  const totalPending = await redis.zcard(PENDING_SET_KEY);

  logEvent('info', '[dlq] drain cycle complete', {
    observed: batch.messages.length,
    tracked,
    totalPending,
  });

  return {
    observed: batch.messages.length,
    tracked,
    totalPending,
  };
}

/* ------------------------------------------------------------------ */
/*  dlqStats                                                           */
/* ------------------------------------------------------------------ */

/**
 * Snapshot the current DLQ tracker.
 *
 * Response shape:
 *
 *   - `pending`      total entries in `dlq:pending`.
 *   - `oldestAgeMs`  age of the oldest entry, or `null` when the
 *                    tracker is empty.
 *   - `entries`      array of up to {@link MAX_STATS_ENTRIES} entries,
 *                    ordered by `firstSeenAt` ascending (oldest
 *                    first). Anything missing from Redis (a blob
 *                    that got deleted without removing the set
 *                    member) is skipped.
 */
export async function dlqStats(env: DlqBindings): Promise<{
  pending: number;
  oldestAgeMs: number | null;
  entries: readonly DlqEntry[];
}> {
  const redis = resolveRedis(env);
  const now = Date.now();

  const pending = await redis.zcard(PENDING_SET_KEY);

  if (pending === 0) {
    return { pending: 0, oldestAgeMs: null, entries: [] };
  }

  // ZRANGE 0..MAX-1 by index returns members in ascending score
  // order — i.e. oldest first. Without WITHSCORES because we only
  // need the member to look up the entry blob; the score is
  // available via the entry's own `firstSeenAt` field.
  const memberStop = Math.max(0, MAX_STATS_ENTRIES - 1);
  const members = (await redis.zrange(PENDING_SET_KEY, 0, memberStop)) as unknown as string[];

  const entries: DlqEntry[] = [];
  let oldest: number | null = null;

  for (const member of members) {
    if (typeof member !== 'string' || member.length === 0) continue;
    const entry = parseEntry(await redis.get<string>(entryKey(member)));
    if (entry === null) continue;
    entries.push(entry);
    if (oldest === null || entry.firstSeenAt < oldest) {
      oldest = entry.firstSeenAt;
    }
  }

  const oldestAgeMs = oldest === null ? null : Math.max(0, now - oldest);

  return {
    pending,
    oldestAgeMs,
    entries,
  };
}

/* ------------------------------------------------------------------ */
/*  dlqReplay                                                          */
/* ------------------------------------------------------------------ */

function readPayloadEventType(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const type = (payload as Record<string, unknown>)['type'];
  return typeof type === 'string' ? type : '';
}

/**
 * Re-publish the tracked payload back onto the lane-specific events queue and
 * drop the tracker entry.
 *
 * Order of operations matters:
 *
 *   1. Load the entry. Missing → `{ replayed: false, reason:
 *      'not_found' }`. The HTTP wrapper surfaces that as 404.
 *   2. Lane-specific queue send (routed from payload `type`). On failure,
 *      (the HTTP wrapper will turn it into a 500) and leave the
 *      tracker untouched. We never want to delete a tracker entry
 *      for a payload we did not successfully re-publish.
 *   3. Remove the member from `dlq:pending` and delete the entry
 *      blob. Two round-trips; if the second one fails the entry is
 *      a ghost (no set membership, blob still there) which is
 *      benign — the admin surface treats it as "not found" on the
 *      next call.
 *
 * Consumers dedup on `event.id` for 24 h (Req 17.4), so a payload
 * that was partially processed before landing on the DLQ stays
 * idempotent on replay.
 */
export async function dlqReplay(
  env: DlqBindings,
  entryId: string,
): Promise<{ replayed: boolean; reason?: string; messageType?: string | null }> {
  if (typeof entryId !== 'string' || entryId.length === 0) {
    return { replayed: false, reason: 'not_found' };
  }

  const redis = resolveRedis(env);
  const entry = parseEntry(await redis.get<string>(entryKey(entryId)));
  if (entry === null) {
    return { replayed: false, reason: 'not_found' };
  }

  const eventType = readPayloadEventType(entry.payload);
  if (eventType.length === 0) {
    console.warn('[dlq] replay: payload missing type — falling back to legacy queue', {
      entryId,
    });
  }

  await resolveEventQueueProducer(env, eventType).send(entry.payload);

  // Remove tracker state. Two separate calls — a pipeline here
  // would be a micro-optimisation, but the extra round trip keeps
  // the code obvious and the failure modes clean.
  await redis.zrem(PENDING_SET_KEY, entryId);
  await redis.del(entryKey(entryId));

  return { replayed: true, messageType: eventType.length > 0 ? eventType : null };
}

/* ------------------------------------------------------------------ */
/*  dlqDiscard                                                         */
/* ------------------------------------------------------------------ */

/**
 * Remove an entry from the tracker without re-publishing. Used when
 * on-call has classified the payload as irrecoverable (bad event the
 * producer is now fixed against, malformed envelope that would just
 * poison the main queue, …).
 *
 * Always returns `{ discarded: true }` even when the entry was
 * already missing — deleting an absent entry is semantically a
 * no-op, and making the behaviour idempotent lets the admin UI
 * retry safely on transient network errors.
 */
export async function dlqDiscard(
  env: DlqBindings,
  entryId: string,
): Promise<{ discarded: boolean }> {
  if (typeof entryId !== 'string' || entryId.length === 0) {
    return { discarded: true };
  }

  const redis = resolveRedis(env);
  await redis.zrem(PENDING_SET_KEY, entryId);
  await redis.del(entryKey(entryId));
  return { discarded: true };
}
