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
 *     read-replica routing (issue #303).
 *
 * Returns the lazy {@link DomainDeps} facade: adapters materialise on
 * first use from the captured env and are memoised per env reference.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { assertRlsRole } from '@athlya/db/client';

import { buildDefaultDeps, buildLazyDomainDeps, type DomainDeps } from './routes/index.js';

import type { AthlyaBindings, HonoEnv } from './types.js';
import type { Hono } from 'hono';

export function installDomainScope(app: Hono<HonoEnv>, owner: string): DomainDeps {
  // `latestEnv` is safe at closure scope: c.env is the same bindings
  // object for every request in one isolate.
  let latestEnv: AthlyaBindings | undefined;
  const cfStorage = new AsyncLocalStorage<{ readonly continent?: string } | undefined>();
  let rlsCheckPromise: Promise<void> | undefined;

  app.use('/v1/*', async (c, next) => {
    latestEnv = c.env;
    if (typeof c.env.DB_URL === 'string' && c.env.DB_URL.length > 0) {
      rlsCheckPromise ??= assertRlsRole(c.env.DB_URL, c.env.ENVIRONMENT ?? '');
      await rlsCheckPromise;
    }
    const cf = (c.req.raw.cf as { continent?: string } | undefined) ?? undefined;
    await cfStorage.run(cf, () => next());
  });

  return buildLazyDomainDeps(() => {
    if (latestEnv === undefined) {
      throw new Error(
        `${owner}: request env not yet captured — the /v1/* scope middleware must run first`,
      );
    }
    return buildDefaultDeps(latestEnv, cfStorage.getStore());
  });
}
