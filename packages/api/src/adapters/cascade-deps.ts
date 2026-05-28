/**
 * Compose the {@link HandleUserDeletedDeps} bundle consumed by
 * {@link import('@athlya/members').handleUserDeleted}.
 *
 * Wires the three Cloudflare Worker bindings the cascade needs into
 * the abstract ports declared by the cascade module:
 *
 *   - `repo`         — Drizzle-backed `DeletionRepo` (this slice).
 *   - `avatars`      — R2-backed `AvatarStore` (this slice, mode
 *                      dégradé when `AVATARS_BUCKET` is unbound).
 *   - `scheduler`    — Stub `Scheduler` that logs at `warn` and
 *                      resolves. The 30-day audit-log anonymisation
 *                      hand-off to QStash is **deferred to a later
 *                      slice** (cf. audit finding S5-003 + the
 *                      "scheduler" port deserves its own dedicated
 *                      adapter once `QSTASH_TOKEN` lands in
 *                      `wrangler.toml`).
 *   - `clock`        — `Date.now()`.
 *   - `logger`       — falls back to a `console`-backed shim if no
 *                      structured logger is available (queue
 *                      consumers run outside the Hono request
 *                      context, so `c.get('logger')` is unavailable
 *                      here).
 *
 * Slice 1.3 — Sprint 1 — resolves audit finding S5-002 (CRITICAL
 * RGPD Article 17 cascade not wired). Pure plumbing: zero new
 * service-layer code, only the missing wiring between the
 * cascade primitive and the live Worker bindings.
 */

import { createR2AvatarStore } from './avatar-store-r2.js';
import { createDrizzleDeletionRepo } from './cascade-repo-drizzle.js';
import { getOrCreateDbHttp } from './deps-cache.js';

import type { AthlyaBindings } from '../types.js';
import type { HandleUserDeletedDeps, Scheduler } from '@athlya/members';

/**
 * Build a degraded-mode {@link Scheduler}.
 *
 * Until QStash is wired (Vague 27+), we keep a no-op stub that:
 *   1. logs a `console.warn` line so ops sees the missing schedule
 *      in Tail Workers (mirrors the audit finding S5-003);
 *   2. resolves the promise so {@link handleUserDeleted}'s "step 6
 *      MUST succeed" branch does not rethrow and re-queue the event
 *      forever.
 *
 * The trade-off is documented in the cascade docblock and in the
 * audit (S5-003): without a real scheduler, the audit-log
 * anonymisation pass at J+30 never runs. Choosing degraded-mode
 * scheduling over rethrow-and-retry is deliberate — replaying the
 * cascade infinitely without a fix would multiply the SQL
 * deletions' cost (already idempotent and harmless) and would still
 * not complete the legal retention window.
 *
 * Once QStash ships, this stub gets replaced by the real
 * `@upstash/qstash` adapter without touching the cascade or the
 * Worker `queue()` dispatcher.
 */
function buildDegradedScheduler(env: AthlyaBindings): Scheduler {
  return {
    scheduleAnonymization(userId, dueAt) {
      console.warn('qstash.schedule.skipped', {
        op: 'anonymize',
        userId,
        dueAt: dueAt.toISOString(),
        env: env.ENVIRONMENT,
        reason: 'qstash_binding_missing',
      });
      return Promise.resolve();
    },
  };
}

/**
 * Produce the {@link HandleUserDeletedDeps} bundle for a live
 * `AthlyaBindings` env.
 *
 * Pure function — no I/O at construction time. The Drizzle handle
 * is read from the per-isolate cache (`deps-cache.ts`); the R2
 * binding is captured by reference (the same binding is consumed
 * by every queue tick within an isolate's lifetime).
 *
 * The returned bundle is consumed by the Worker's `queue()`
 * dispatcher in `worker.ts` once per `auth.user.deleted` event.
 */
export function buildCascadeDeps(env: AthlyaBindings): HandleUserDeletedDeps {
  const db = getOrCreateDbHttp(env.DB_URL);
  const repo = createDrizzleDeletionRepo(db);
  const avatars = createR2AvatarStore(env.AVATARS_BUCKET, {
    env: env.ENVIRONMENT,
  });
  const scheduler = buildDegradedScheduler(env);

  return {
    repo,
    avatars,
    scheduler,
    clock: { now: () => Date.now() },
    logger: {
      warn: (msg, extra) => {
        console.warn(`[cascade] ${msg}`, extra ?? {});
      },
      error: (msg, extra) => {
        console.error(`[cascade] ${msg}`, extra ?? {});
      },
    },
  };
}
