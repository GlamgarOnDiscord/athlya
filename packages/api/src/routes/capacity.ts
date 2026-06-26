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
import { rateLimitSlidingWindow } from '@athlya/ratelimit';

import { getOrCreateRedisForEnv } from '../adapters/deps-cache.js';
import { deriveClientIp } from '../middleware/rate-limit.js';

import type { HonoEnv } from '../types.js';

const WS_CONNECT_LIMIT = 20;
const WS_CONNECT_WINDOW_SEC = 60;
const WS_RATE_LIMIT_PREFIX = 'rl:capacity-ws:ip';

export function buildCapacityRouter(): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  router.get('/:classId/capacity/ws', async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }

    try {
      const redis = getOrCreateRedisForEnv(c.env);
      const ip = deriveClientIp(c.req);
      const key = `${WS_RATE_LIMIT_PREFIX}:${ip}`;
      const decision = await rateLimitSlidingWindow(
        { redis },
        key,
        WS_CONNECT_LIMIT,
        WS_CONNECT_WINDOW_SEC,
      );
      if (decision.kind === 'deny') {
        return c.body(
          JSON.stringify({
            type: 'about:blank',
            title: 'Too Many Requests',
            status: 429,
            code: 'capacity_ws_rate_limited',
            detail: `Too many WebSocket connections — retry after ${String(decision.retryAfterSec)}s`,
          }),
          429,
          {
            'content-type': 'application/problem+json',
            'retry-after': String(decision.retryAfterSec),
          },
        );
      }
    } catch {
      // Redis unavailable — fail-open, allow the connection
    }

    const { classId } = c.req.param();
    const do_ = c.env.CLASS_CAPACITY_DO;

    if (!do_) {
      return c.json({ error: 'capacity_do_unavailable' }, 503);
    }

    const id = do_.idFromName(classId);
    const stub = do_.get(id);

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value: string, key: string) => {
      headers[key] = value;
    });
    return stub.fetch(c.req.url, { headers }) as unknown as Promise<Response>;
  });

  return router;
}
