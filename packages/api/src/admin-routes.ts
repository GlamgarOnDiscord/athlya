/**
 * `/admin/*` operator routers (DLQ drain, outbox admin, JWT rotation).
 *
 * Passed as `mountAdmin` to `buildBaseApp()` by the Workers that serve
 * `/admin/*` — the monolith gateway and the billing bulkhead Worker
 * (issue #230). Kept out of `base-app.ts` so the auth and reservations
 * Workers neither bundle nor expose the admin surface.
 *
 * The guard chain (rate limit, CF Access, `jwtAuth()`,
 * `requireRole('admin')`) is installed by `buildBaseApp()` before this
 * runs, so every router here inherits it.
 */

import { lazyDlqAuditWriter, lazyJwtRotateAuditWriter } from './adapters/audit-log-wiring.js';
import { buildDlqRouter } from './admin/dlq-routes.js';
import { buildJwtRotateRouter } from './admin/jwt-rotate-routes.js';
import { buildOutboxRouter } from './admin/outbox-routes.js';

import type { AthlyaBindings, HonoEnv } from './types.js';
import type { Hono } from 'hono';

export function mountAdminRouters(app: Hono<HonoEnv>, getAdminEnv: () => AthlyaBindings): void {
  // The DLQ router exposes its routes under the literal `/admin/dlq/*`
  // prefix (each handler hard-codes the full path), so it mounts at
  // `app.route('/', router)` rather than at `/admin/dlq` —
  // double-prefixing would shift the routes to `/admin/dlq/admin/dlq/*`
  // and break the contract documented in `dlq-routes.test.ts`.
  app.route(
    '/',
    buildDlqRouter({ auditWriter: lazyDlqAuditWriter(getAdminEnv) }) as unknown as Hono<HonoEnv>,
  );
  app.route('/', buildOutboxRouter());

  // Sprint 12 / Slice 12.13 (Epic B3.1) — JWT rotation admin surface.
  // The router already enforces `enforceAdmin()` per-route as defence
  // in depth, mirroring `buildDlqRouter`.
  //
  // Endpoints exposed:
  //   • GET  /admin/jwt/state           — read-only snapshot
  //   • POST /admin/jwt/rotate-prepare  — generate new keypair
  //
  // Operator runbook: `docs/runbooks/rotate-jwt.md`. Audit rows are
  // appended via `lazyJwtRotateAuditWriter` (issue #127).
  app.route('/', buildJwtRotateRouter({ auditWriter: lazyJwtRotateAuditWriter(getAdminEnv) }));
}
