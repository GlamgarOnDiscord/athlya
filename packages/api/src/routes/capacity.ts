/**
 * `/v1/classes/:classId/capacity/ws` — public WebSocket endpoint.
 *
 * Proxies the WebSocket upgrade to the ClassCapacityDO for the given
 * class. Clients receive `{ type: 'capacity_update', classId, remaining }`
 * messages in real time whenever a booking or cancellation occurs.
 *
 * No authentication required — remaining seat counts are already
 * visible on the public class listing (`GET /v1/classes`).
 *
 * The `CLASS_CAPACITY_DO` binding is optional: when absent the endpoint
 * returns 503 so callers can degrade gracefully.
 *
 * CN.8.1 — Sprint 8 (real-time capacity).
 */

import { Hono } from 'hono';

import type { HonoEnv } from '../types.js';

export function buildCapacityRouter(): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  router.get('/:classId/capacity/ws', async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }

    const { classId } = c.req.param();
    const do_ = c.env.CLASS_CAPACITY_DO;

    if (!do_) {
      return c.json({ error: 'capacity_do_unavailable' }, 503);
    }

    const id = do_.idFromName(classId);
    const stub = do_.get(id);

    // Forward all original headers (including Sec-WebSocket-Key, Sec-WebSocket-Version
    // and any sub-protocol headers) so the DO can complete the WebSocket handshake.
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value: string, key: string) => {
      headers[key] = value;
    });
    // CF Workers Response type differs structurally from the standard Response
    // type used by Hono — the assertion bridges the two without changing
    // runtime behaviour.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return stub.fetch(c.req.url, { headers }) as unknown as Promise<Response>;
  });

  return router;
}
