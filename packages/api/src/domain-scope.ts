/**
 * Request scope shared by every Worker that serves `/v1/*` domain routes —
 * the monolith gateway and each bulkhead sub-worker (issue #230).
 *
 * Installs, on `/v1/*`:
 *   • capture of the Cloudflare bindings for the lazy deps facade,
 *   • the per-isolate BYPASSRLS guard (issue #461): the first request
 *     fails if DB_URL connects with a BYPASSRLS role outside dev,
 *   • a per-request `cf` scope via AsyncLocalStorage, so concurrent
 *     requests in one isolate never share the continent used for EU
 *     read-replica routing (issue #303),
 *   • the outbox kick scope (issue #311): a request whose handler wrote
 *     an outbox row enqueues one `outbox.kick` after it returns, so the
 *     gateway drains it without waiting for the cron.
 *
 * Returns a resolver that runs `build` against the captured env and the
 * current request's `cf`. Callers wrap it in the lazy facades of
 * `./domain-deps.ts` for the domains they serve, so a sub-worker never
 * imports or builds the adapters of another domain.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { assertRlsRole } from '@athlya/db/client';

import { runWithOutboxKickScope } from './events/outbox-kick.js';

import type { RequestCf } from './domain-deps.js';
import type { AthlyaBindings, HonoEnv } from './types.js';
import type { Hono } from 'hono';

export function installDomainScope<D>(
  app: Hono<HonoEnv>,
  owner: string,
  build: (env: AthlyaBindings, cf: RequestCf) => D,
): () => D {
  // `latestEnv` is safe at closure scope: c.env is the same bindings
  // object for every request in one isolate.
  let latestEnv: AthlyaBindings | undefined;
  const cfStorage = new AsyncLocalStorage<RequestCf>();
  let rlsCheckPromise: Promise<void> | undefined;

  app.use('/v1/*', async (c, next) => {
    latestEnv = c.env;
    if (typeof c.env.DB_URL === 'string' && c.env.DB_URL.length > 0) {
      // A rejected check is not cached: a transient Neon failure must not
      // poison the isolate, so the next request retries the check.
      rlsCheckPromise ??= assertRlsRole(c.env.DB_URL, c.env.ENVIRONMENT ?? '').catch(
        (error: unknown) => {
          rlsCheckPromise = undefined;
          throw error;
        },
      );
      await rlsCheckPromise;
    }
    const cf = (c.req.raw.cf as { continent?: string } | undefined) ?? undefined;
    await runWithOutboxKickScope(c, () => cfStorage.run(cf, () => next()));
  });

  return () => {
    if (latestEnv === undefined) {
      throw new Error(
        `${owner}: request env not yet captured — the /v1/* scope middleware must run first`,
      );
    }
    return build(latestEnv, cfStorage.getStore());
  };
}
