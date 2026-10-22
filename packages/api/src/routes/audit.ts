/**
 * `/v1/audit` domain router — task 12.5.
 *
 * Endpoints:
 *
 *   | Method | Path | Chain                                               |
 *   |--------|------|-----------------------------------------------------|
 *   | GET    | /    | jwtAuth → requireCapability('audit.read') → zValidator(query) → handler |
 *
 * Cursor-based pagination keyed by `audit_log.id` (BIGSERIAL, newest
 * first). Clients pass `cursor=<last-seen-id>` to fetch the next page
 * of older events.
 *
 * Requirements:
 *   • 22.3 — admin-scoped read of the immutable audit log.
 *   • 14.1, 14.2 — auth / validation.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { readValidated, requireCapability, traceOperation } from './helpers.js';

import type { HonoEnv } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Query schema                                                        */
/* ------------------------------------------------------------------ */

const ListAuditQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

type ListAuditQuery = z.infer<typeof ListAuditQuerySchema>;

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

export interface AuditListItem {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

export interface AuditPage {
  readonly items: ReadonlyArray<AuditListItem>;
  readonly nextCursor: string | null;
}

export interface AuditDeps {
  listAuditLog(studioId: string, opts: { cursor?: string; limit: number }): Promise<AuditPage>;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                             */
/* ------------------------------------------------------------------ */

export function buildAuditRouter(deps: AuditDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  router.get(
    '/',
    requireCapability('audit.read'),
    zValidator('query', ListAuditQuerySchema),
    async (c) => {
      traceOperation(c, 'audit.list');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const query = readValidated<ListAuditQuery>(c, 'query');
      const opts: { cursor?: string; limit: number } = { limit: query.limit ?? 20 };
      if (query.cursor !== undefined) opts.cursor = query.cursor;
      const page = await deps.listAuditLog(claims.studioId, opts);
      return c.json(page, 200);
    },
  );

  return router;
}
