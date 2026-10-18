/**
 * Athlya API gateway — Cloudflare Worker entrypoint (task 8.1).
 *
 * The middleware chain and route mounting live in `./base-app.ts`, which
 * has no module-level side effects so the bulkhead sub-workers
 * (`./workers/*.ts`) can import it without bundling this monolith entry
 * (issue #230). This module instantiates the gateway singleton and wires
 * the Worker default export: `fetch`, `scheduled` (outbox drain, RGPD
 * maintenance, keepalive) and the queue consumers.
 */

import { handleUserDeleted, runExportJob } from '@athlya/members';
import { HANDLED_EVENT_TYPES, handleEvent as handleNotificationEvent } from '@athlya/notifications';
import { createRedisRemainingCounter } from '@athlya/reservations/counter';
import {
  parseEvent,
  type AthlyaEvent,
  type AuthUserDeletedEvent,
  type MembersExportRequestedEvent,
} from '@athlya/shared/events';

import { buildPasswordResetDeliveryDeps } from './adapters/auth-deps.js';
import { buildCascadeDeps } from './adapters/cascade-deps.js';
import { buildCronSqlExecutor } from './adapters/cron-sql-executor.js';
import { getOrCreateRedis } from './adapters/deps-cache.js';
import { resolveDrainDbUrl, withDrainDb } from './adapters/drain-db.js';
import { buildExportDeps } from './adapters/export-deps.js';
import { buildNotificationsDeps } from './adapters/notifications-deps.js';
import { createRedisPasswordResetDeliveryStore } from './adapters/password-reset-delivery-store-redis.js';
import { buildApp } from './app.js';
import { handleDlqBatch } from './events/drain-dlq.js';
import { runKickDrain, runScheduledDrain } from './events/drain-scheduled.js';
import { handleOutboxKickBatch, isOutboxKickQueue } from './events/outbox-kick.js';
import {
  PASSWORD_RESET_IN_FLIGHT_TTL_SECONDS,
  PasswordResetDeliveryInFlightError,
  handlePasswordResetRequested,
} from './events/password-reset-consumer.js';
import { rejectUnknownQueueEvent } from './events/reject-unknown-queue-event.js';
import { isNotificationsConsumerQueue, isRgpdConsumerQueue } from './events/route-queue.js';
import { runScheduledCapacityReconcile } from './maintenance/capacity-reconcile-runner.js';
import { logCronDbUrlMissing, shouldRequireCronDbUrl } from './maintenance/cron-db-config.js';
import { runDbKeepalive } from './maintenance/db-keepalive.js';
import { runScheduledRgpdMaintenance } from './maintenance/scheduled-runner.js';
import { createSentryClient } from './sentry.js';

import type { DlqBindings } from './events/drain-dlq.js';
import type { ExecutionContext, ScheduledEnv, ScheduledEvent } from './events/drain-scheduled.js';
import type { AthlyaBindings } from './types.js';
import type { MessageBatch } from '@cloudflare/workers-types';

export { buildApp, __buildAppInternal } from './app.js';
export type { BuildAppOptions } from './app.js';

/**
 * Singleton gateway instance. Named so domain route registration
 * tasks (8.11) can compose mounts onto the shared app:
 *
 *   import { app } from '@athlya/api';
 *   app.route('/v1/reservations', reservationsRouter);
 *
 * Tests build their own app via {@link buildApp} to keep request-
 * level isolation.
 */
export const app = buildApp();

export { ClassCapacityDO } from './durable-objects/class-capacity.js';

/* ------------------------------------------------------------------ */
/*  Worker default export                                              */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare Worker module shape. Wrangler (`main = "src/worker.ts"`)
 * expects a default export with `fetch` and / or `scheduled`.
 *
 *   • `fetch` delegates to the Hono app's `fetch` so every HTTP
 *     request goes through the middleware chain built above.
 *   • `scheduled` delegates to the drain handler shipped by task 9.3
 *     (Req 16.4). The cron cadence is defined in `wrangler.toml`;
 *     wiring it here keeps the drain operational the moment a cron
 *     trigger is enabled on the Worker.
 *   • `queue` routes incoming queue batches to the right consumer
 *     based on `batch.queue`. Today the only branch is the
 *     `athlya-events-dlq` drain (hardening task H2) — messages are
 *     upserted into a Redis-backed tracker so ops can inspect them
 *     via `/admin/dlq/*`. Additional queues (9.5 Notifications,
 *     future workflows) will add more branches without touching the
 *     envelope above.
 */
const worker = {
  fetch: app.fetch.bind(app),
  scheduled(event: ScheduledEvent, env: ScheduledEnv, ctx: ExecutionContext): void {
    // Catch infrastructural failures so a crashing cron does not
    // surface as an unhandled rejection. Per-row failures are
    // already swallowed internally by `drainOutbox` and summarised
    // via its `DrainResult`; this catch fires only on
    // `claimBatch` / transaction-level failures.
    // Issue #497 — the drain runs as athlya_cron through CRON_DB_URL;
    // there is no `getDb` binding on a real Worker env.
    const drainDbUrl = resolveDrainDbUrl(env as unknown as AthlyaBindings);
    if (drainDbUrl === null) {
      console.error('[worker] CRON_DB_URL missing — outbox drain skipped', {
        code: 'configuration_error',
        binding: 'CRON_DB_URL',
        environment: (env as unknown as AthlyaBindings).ENVIRONMENT ?? 'unknown',
        cron: event.cron,
        scheduledTime: event.scheduledTime,
      });
    }
    const drainTask = (
      drainDbUrl === null
        ? Promise.resolve()
        : withDrainDb(drainDbUrl, (db) => runScheduledDrain({ ...env, getDb: () => db }))
    ).catch((err: unknown) => {
      // Log through the console-backed default logger — the
      // drain module does not accept `StructuredLogger` shapes
      // and we do not want to convert here; task 8.6 (OTel)
      // will unify the two shapes.
      console.error('[worker] scheduled drain failed', {
        cron: event.cron,
        scheduledTime: event.scheduledTime,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    ctx.waitUntil(drainTask);

    // Sprint 13 / Slice 13.2 (SP6.5 + SP7.6 + SP8.3) — RGPD
    // maintenance cycle. Runs strictly after the outbox drain
    // so a backed-up event queue does not delay user
    // anonymisation. Dev may omit `CRON_DB_URL`; staging/production
    // log `configuration_error` when the binding is absent.
    //
    // The audit-anonymise pass is gated on `CRON_DB_URL` pointing at
    // `athlya_cron` (NOBYPASSRLS, migration 0019): it calls the
    // cron-only `anonymize_user_audit()` SECURITY DEFINER function.
    const athlyaEnv = env as AthlyaBindings & ScheduledEnv;
    const cronExecutor = buildCronSqlExecutor(athlyaEnv.CRON_DB_URL);

    // Issue #316 — DB keepalive probe. Measures CRON_DB_URL round-trip
    // latency on every tick. Logs db_keepalive + db_cold_start_suspected
    // when latency > 400ms so Axiom can alert before user traffic is
    // affected. Long-term mitigation: min_cu=0.25 on Neon compute.
    if (cronExecutor !== null) {
      const keepaliveTask = runDbKeepalive(cronExecutor, { label: 'cron_db' }).catch(
        (err: unknown) => {
          console.error('[worker] db keepalive failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
      ctx.waitUntil(keepaliveTask);
    }

    if (cronExecutor !== null) {
      const rgpdTask = runScheduledRgpdMaintenance({
        executeSql: cronExecutor,
        // Sprint 13 / Slice 13.3 (Epic B10.2) — anonymise each user
        // through `anonymize_user_audit()`, the SECURITY DEFINER
        // function granted to `athlya_cron` (migration 0003).
        anonymizeOne: async (userId) => {
          const rows = await cronExecutor.selectRows<{ touched: number }>(
            'SELECT anonymize_user_audit($1::uuid)::int AS touched',
            [userId],
          );
          return { anonymizedRows: rows[0]?.touched ?? 0 };
        },
      }).catch((err: unknown) => {
        console.error('[worker] scheduled rgpd maintenance failed', {
          cron: event.cron,
          scheduledTime: event.scheduledTime,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      ctx.waitUntil(rgpdTask);
    } else if (shouldRequireCronDbUrl(athlyaEnv.ENVIRONMENT)) {
      logCronDbUrlMissing({
        environment: athlyaEnv.ENVIRONMENT,
        cron: event.cron,
        scheduledTime: event.scheduledTime,
      });
      // Issue #269 — also surface to Sentry so the missing binding
      // triggers an on-call alert rather than silently skipping RGPD
      // anonymisation. createSentryClient is a no-op when SENTRY_DSN
      // is absent, so this is safe to call unconditionally.
      const sentryAlert = createSentryClient({
        ...(athlyaEnv.SENTRY_DSN !== undefined ? { dsn: athlyaEnv.SENTRY_DSN } : {}),
        environment: athlyaEnv.ENVIRONMENT,
        ...(athlyaEnv.VERSION !== undefined ? { release: athlyaEnv.VERSION } : {}),
      }).captureException(new Error('CRON_DB_URL missing — RGPD maintenance skipped'), {
        tags: {
          code: 'configuration_error',
          binding: 'CRON_DB_URL',
          cron: event.cron ?? 'unknown',
        },
      });
      ctx.waitUntil(sentryAlert);
    }

    // Issue #135 — capacity drift reconciliation. Compares the Redis
    // remaining-seats counter against the authoritative PG confirmed
    // count for every active class, emits `capacity_redis_pg_drift`
    // (alert A17) and auto-heals Redis from PG. Needs the cron executor
    // (cross-tenant counts through `capacity_reconcile_snapshot()`,
    // migration 0040) AND Redis credentials; skipped silently otherwise
    // so dev without `CRON_DB_URL` stays quiet.
    if (cronExecutor !== null && athlyaEnv.REDIS_URL && athlyaEnv.REDIS_TOKEN) {
      const counter = createRedisRemainingCounter(
        getOrCreateRedis(athlyaEnv.REDIS_URL, athlyaEnv.REDIS_TOKEN),
      );
      const reconcileTask = runScheduledCapacityReconcile({
        executeSql: cronExecutor,
        counter,
      }).catch((err: unknown) => {
        console.error('[worker] scheduled capacity reconcile failed', {
          cron: event.cron,
          scheduledTime: event.scheduledTime,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      ctx.waitUntil(reconcileTask);
    } else if (cronExecutor !== null && shouldRequireCronDbUrl(athlyaEnv.ENVIRONMENT)) {
      // Required env with a working cron DB but no Redis credentials:
      // the auto-heal job is silently absent otherwise. Surface a
      // configuration error so ops sees the gap (mirrors the
      // CRON_DB_URL-missing signal above).
      console.error('[worker] capacity reconcile: configuration_error', {
        code: 'configuration_error',
        reason: 'REDIS_URL/REDIS_TOKEN missing — capacity drift reconciliation disabled',
        environment: athlyaEnv.ENVIRONMENT,
        cron: event.cron,
        scheduledTime: event.scheduledTime,
      });
    }

    // Issue #235 — auto-provision the next monthly audit_log partition 7 days
    // before month rollover. The function is idempotent so running it on every
    // cron tick is safe. Skipped silently when CRON_DB_URL is absent (dev).
    if (cronExecutor !== null) {
      const partitionTask = cronExecutor
        .selectRows<{ ensure_next_audit_log_partition: string }>(
          'SELECT ensure_next_audit_log_partition(now())',
          [],
        )
        .then((rows) => {
          console.log('[worker] audit_log partition ensured', {
            result: rows[0]?.ensure_next_audit_log_partition,
          });
        })
        .catch((err: unknown) => {
          console.error('[worker] audit_log partition provision failed', {
            cron: event.cron,
            scheduledTime: event.scheduledTime,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      ctx.waitUntil(partitionTask);
    }
  },
  /**
   * Queue consumer dispatch. Cloudflare delivers every queue
   * subscribed via `[[queues.consumers]]` in `wrangler.toml` to
   * this single entry point; `batch.queue` identifies which one
   * produced the batch. We dispatch by queue name and use
   * `ctx.waitUntil` so the isolate stays alive until the handler
   * resolves, even if this method has already returned.
   *
   * Branches:
   *
   *   0. `athlya-outbox-kick*` → one bounded outbox drain for the whole
   *      batch (issue #311, {@link runOutboxKickBatch}). The promise is
   *      returned so `max_concurrency = 1` serialises kick drains.
   *
   *   1. `athlya-events-dlq` (and its per-env equivalents
   *      `athlya-events-staging-dlq` / `athlya-events-production-dlq`)
   *      → DLQ tracker drain (hardening task H2). Per-message
   *      failures are swallowed inside {@link handleDlqBatch}; the
   *      outer catch only fires on infrastructural failures —
   *      Redis unreachable, serialisation panics — and surfaces
   *      them via `console.error` so Tail Workers can alert.
   *
   *   2. Everything else (the main `athlya-events` queue and its
   *      per-env equivalents) → domain consumers dispatch
   *      (Slice 1.3 — Sprint 1 — SP1.4, audit findings S5-001,
   *      S5-002 + issue #60 notifications wiring). Each message is
   *      parsed for `event.type` and routed to the matching consumer:
   *        • `auth.user.deleted` → `handleUserDeleted` cascade
   *          (Article 17 — purges reservations, workout_sessions,
   *          push_tokens, R2 avatar; schedules J+30 audit
   *          anonymisation).
   *        • `members.export.requested` → `runExportJob` (Article
   *          15/20 — assembles the ZIP archive, uploads to R2,
   *          stamps the export job `completed`).
   *        • `reservation.*` + `billing.subscription.failed`
   *          → `@athlya/notifications/handleEvent` with Redis dedup
   *          and Drizzle recipient lookup.
   *        • Any other event type is ack'd unconditionally. Unknown
   *          types must NOT be `retry`'d:
   *          Cloudflare's at-least-once redelivery would loop the
   *          message forever and eventually push it to the DLQ for
   *          no reason.
   *
   * Per-message error handling: a thrown error from a known
   * consumer triggers `msg.retry()` so Cloudflare's `max_retries`
   * budget (5, see `wrangler.toml`) eventually shuttles the message
   * to the DLQ; success path acks. We deliberately do NOT ack on
   * the catch path — losing a delete event would leave the user in
   * a half-deleted state.
   */
  queue(
    batch: MessageBatch<unknown>,
    env: AthlyaBindings & DlqBindings,
    ctx: ExecutionContext,
  ): void | Promise<void> {
    if (isOutboxKickQueue(batch.queue)) {
      return runOutboxKickBatch(batch, env);
    }

    // The DLQ queues used in dev / staging / production each
    // carry the `-dlq` suffix; matching on the suffix keeps the
    // dispatch loop env-agnostic without enumerating every name.
    const isDlq = batch.queue.endsWith('-dlq');

    if (isDlq) {
      const task = handleDlqBatch(batch, env).catch((err: unknown) => {
        console.error('[worker] dlq handler failed', {
          queue: batch.queue,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      ctx.waitUntil(task);
      return;
    }

    if (isNotificationsConsumerQueue(batch.queue)) {
      const task = handleNotificationsBatch(batch, env).catch((err: unknown) => {
        console.error('[worker] notifications dispatcher failed', {
          queue: batch.queue,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      ctx.waitUntil(task);
      return;
    }

    if (isRgpdConsumerQueue(batch.queue)) {
      const task = handleRgpdBatch(batch, env).catch((err: unknown) => {
        console.error('[worker] rgpd dispatcher failed', {
          queue: batch.queue,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      ctx.waitUntil(task);
      return;
    }

    // Legacy monolithic events queue — drains backlog during migration.
    const task = handleEventsBatch(batch, env).catch((err: unknown) => {
      console.error('[worker] events dispatcher failed', {
        queue: batch.queue,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    ctx.waitUntil(task);
  },
};

export default worker;

/**
 * Outbox kick consumer (issue #311): coalesce the batch into one bounded
 * drain as `athlya_cron`, exactly like the cron drain. Without a drain
 * connection the kicks are acked: the cron logs the configuration error
 * every minute already.
 */
export function runOutboxKickBatch(
  batch: MessageBatch<unknown>,
  env: AthlyaBindings,
): Promise<void> {
  return handleOutboxKickBatch(batch, async () => {
    const drainDbUrl = resolveDrainDbUrl(env);
    if (drainDbUrl === null) return null;
    return withDrainDb(drainDbUrl, (db) =>
      runKickDrain({ ...(env as unknown as ScheduledEnv), getDb: () => db }),
    );
  });
}

/* ------------------------------------------------------------------ */
/*  Events dispatcher (Slice 1.3 — Sprint 1 — SP1.4)                  */
/* ------------------------------------------------------------------ */

/**
 * Narrow envelope shape used by the dispatcher. Cloudflare delivers
 * the message body as `unknown` — the producer (`@athlya/api/events/publish`)
 * always sends a parsed {@link AthlyaEvent}, but defensive narrowing
 * keeps us safe against a malformed third-party producer or a hand-
 * crafted replay during testing.
 */
function readEventEnvelope(body: unknown): { type: string; id?: string; payload?: unknown } | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string' || type.length === 0) return null;
  return {
    type,
    ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
    ...(record['payload'] !== undefined ? { payload: record['payload'] } : {}),
  };
}

const NOTIFICATION_EVENT_TYPES = new Set<string>(HANDLED_EVENT_TYPES);

const PASSWORD_RESET_REQUESTED = 'auth.password_reset.requested';

/**
 * Deliver one `auth.password_reset.requested` message (issue #645).
 * A malformed envelope is acked (retrying cannot fix it); a delivery
 * failure throws so the caller retries the message, and the queue
 * dead-letters it once `max_retries` is spent.
 */
async function deliverPasswordResetMessage(
  msg: MessageBatch<unknown>['messages'][number],
  queue: string,
  env: AthlyaBindings,
): Promise<void> {
  let event: AthlyaEvent;
  try {
    event = parseEvent(msg.body);
  } catch (err) {
    console.warn('[worker] password-reset event malformed, acking', {
      queue,
      messageId: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
    msg.ack();
    return;
  }
  if (event.type !== PASSWORD_RESET_REQUESTED) {
    throw new Error(`unexpected event type ${event.type} on the password-reset path`);
  }
  try {
    await handlePasswordResetRequested(event, {
      deliveries: buildPasswordResetDeliveryStore(env),
      delivery: buildPasswordResetDeliveryDeps(env),
    });
  } catch (err) {
    if (!(err instanceof PasswordResetDeliveryInFlightError)) throw err;
    // Another attempt holds the in-flight mark: come back once it has
    // completed or, if that isolate died, once the mark has expired.
    msg.retry({ delaySeconds: PASSWORD_RESET_IN_FLIGHT_TTL_SECONDS });
    return;
  }
  msg.ack();
}

function buildPasswordResetDeliveryStore(env: AthlyaBindings) {
  return createRedisPasswordResetDeliveryStore(getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN));
}

/**
 * Dispatch every message of a non-DLQ queue batch.
 *
 * Exported as a free function (rather than inlined in `queue()`) so
 * the integration tests can drive the dispatcher directly with a
 * synthetic `MessageBatch` and assert ack/retry semantics without
 * touching the Hono surface.
 */
export async function handleRgpdBatch(
  batch: MessageBatch<unknown>,
  env: AthlyaBindings,
): Promise<void> {
  for (const msg of batch.messages) {
    const envelope = readEventEnvelope(msg.body);
    if (envelope === null) {
      console.warn('[worker] rgpd dispatcher: malformed envelope, acking', {
        queue: batch.queue,
        messageId: msg.id,
      });
      msg.ack();
      continue;
    }

    try {
      switch (envelope.type) {
        case 'auth.user.deleted': {
          const envelopePayload =
            typeof envelope['payload'] === 'object' && envelope['payload'] !== null
              ? (envelope['payload'] as Record<string, unknown>)
              : undefined;
          const rawUserId: unknown = envelopePayload?.['userId'];
          if (
            typeof rawUserId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawUserId)
          ) {
            console.warn('[worker] auth.user.deleted: invalid userId — acking without processing', {
              messageId: msg.id,
            });
            msg.ack();
            break;
          }
          await handleUserDeleted(msg.body as AuthUserDeletedEvent, buildCascadeDeps(env));
          msg.ack();
          break;
        }
        case 'members.export.requested': {
          const event = msg.body as MembersExportRequestedEvent;
          await runExportJob(event.payload.exportJobId, buildExportDeps(env));
          msg.ack();
          break;
        }
        default: {
          await rejectUnknownQueueEvent(
            msg,
            {
              queue: batch.queue,
              messageId: msg.id,
              eventType: envelope.type,
              eventId: envelope.id,
            },
            env,
          );
          break;
        }
      }
    } catch (err) {
      console.error('[worker] rgpd consumer failed', {
        queue: batch.queue,
        messageId: msg.id,
        eventType: envelope.type,
        eventId: envelope.id,
        error: err instanceof Error ? err.message : String(err),
      });
      msg.retry();
    }
  }
}

export async function handleNotificationsBatch(
  batch: MessageBatch<unknown>,
  env: AthlyaBindings,
): Promise<void> {
  for (const msg of batch.messages) {
    const envelope = readEventEnvelope(msg.body);
    if (envelope === null) {
      console.warn('[worker] notifications dispatcher: malformed envelope, acking', {
        queue: batch.queue,
        messageId: msg.id,
      });
      msg.ack();
      continue;
    }

    try {
      if (envelope.type === PASSWORD_RESET_REQUESTED) {
        await deliverPasswordResetMessage(msg, batch.queue, env);
        continue;
      }

      if (!NOTIFICATION_EVENT_TYPES.has(envelope.type)) {
        await rejectUnknownQueueEvent(
          msg,
          {
            queue: batch.queue,
            messageId: msg.id,
            eventType: envelope.type,
            eventId: envelope.id,
          },
          env,
        );
        continue;
      }

      let event: AthlyaEvent;
      try {
        event = parseEvent(msg.body);
      } catch (err) {
        console.warn('[worker] notifications event malformed, acking', {
          queue: batch.queue,
          messageId: msg.id,
          eventType: envelope.type,
          error: err instanceof Error ? err.message : String(err),
        });
        msg.ack();
        continue;
      }
      await handleNotificationEvent(event, buildNotificationsDeps(env));
      msg.ack();
    } catch (err) {
      console.error('[worker] notifications consumer failed', {
        queue: batch.queue,
        messageId: msg.id,
        eventType: envelope.type,
        eventId: envelope.id,
        error: err instanceof Error ? err.message : String(err),
      });
      msg.retry();
    }
  }
}

export async function handleEventsBatch(
  batch: MessageBatch<unknown>,
  env: AthlyaBindings,
): Promise<void> {
  for (const msg of batch.messages) {
    const envelope = readEventEnvelope(msg.body);
    if (envelope === null) {
      // Malformed payload — ack rather than retry. A producer
      // that emits a non-event onto the events queue is a bug
      // upstream; redelivering it forever would burn retry
      // budget for no reason. The structured log line surfaces
      // the incident in Tail Workers / Logpush.
      console.warn('[worker] events dispatcher: malformed envelope, acking', {
        queue: batch.queue,
        messageId: msg.id,
      });
      msg.ack();
      continue;
    }

    try {
      switch (envelope.type) {
        case 'auth.user.deleted': {
          // Guard against a crafted DLQ replay injecting an
          // arbitrary userId — a string UUID is the minimum
          // shape we need before delegating to the cascade.
          const envelopePayload =
            typeof envelope['payload'] === 'object' && envelope['payload'] !== null
              ? (envelope['payload'] as Record<string, unknown>)
              : undefined;
          const rawUserId: unknown = envelopePayload?.['userId'];
          if (
            typeof rawUserId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawUserId)
          ) {
            console.warn('[worker] auth.user.deleted: invalid userId — acking without processing', {
              messageId: msg.id,
            });
            msg.ack();
            break;
          }
          await handleUserDeleted(msg.body as AuthUserDeletedEvent, buildCascadeDeps(env));
          msg.ack();
          break;
        }
        case 'members.export.requested': {
          const event = msg.body as MembersExportRequestedEvent;
          await runExportJob(event.payload.exportJobId, buildExportDeps(env));
          // `runExportJob` returns a discriminated result
          // (`completed` / `already_completed` / `failed` /
          // `not_found`) — every kind is a terminal state
          // the consumer is allowed to ack. The `failed`
          // branch already stamped `export_jobs.error` so
          // the user-facing surface surfaces the error;
          // retrying the queue message would just loop the
          // failure forever.
          msg.ack();
          break;
        }
        case PASSWORD_RESET_REQUESTED: {
          // Backlog published to the monolithic queue (e.g. a DLQ
          // replay) is delivered like the notifications lane does.
          await deliverPasswordResetMessage(msg, batch.queue, env);
          break;
        }
        default: {
          if (NOTIFICATION_EVENT_TYPES.has(envelope.type)) {
            let event: AthlyaEvent;
            try {
              event = parseEvent(msg.body);
            } catch (err) {
              console.warn('[worker] notifications event malformed, acking', {
                queue: batch.queue,
                messageId: msg.id,
                eventType: envelope.type,
                error: err instanceof Error ? err.message : String(err),
              });
              msg.ack();
              break;
            }
            await handleNotificationEvent(event, buildNotificationsDeps(env));
            msg.ack();
            break;
          }

          await rejectUnknownQueueEvent(
            msg,
            {
              queue: batch.queue,
              messageId: msg.id,
              eventType: envelope.type,
              eventId: envelope.id,
            },
            env,
          );
          break;
        }
      }
    } catch (err) {
      // Consumer threw — let Cloudflare retry within the
      // `max_retries = 5` budget. A persistent failure
      // eventually lands on the DLQ, where the H2 drain picks
      // it up and surfaces an alert.
      console.error('[worker] events consumer failed', {
        queue: batch.queue,
        messageId: msg.id,
        eventType: envelope.type,
        eventId: envelope.id,
        error: err instanceof Error ? err.message : String(err),
      });
      msg.retry();
    }
  }
}
