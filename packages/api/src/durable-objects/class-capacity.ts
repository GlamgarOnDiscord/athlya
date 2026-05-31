/**
 * ClassCapacityDO — Durable Object for real-time class capacity updates.
 *
 * One instance per class (keyed by classId via `idFromName`). Clients
 * connect via WebSocket and receive `capacity_update` messages whenever
 * a seat is booked or cancelled.
 *
 * Uses the Hibernation WebSocket API (`ctx.acceptWebSocket` /
 * `ctx.getWebSockets`) so the DO can sleep between broadcasts without
 * dropping connected clients — Cloudflare resumes it on the next
 * `webSocketMessage` or `fetch` call.
 *
 * Two request types handled by `fetch()`:
 *   • `Upgrade: websocket` — register a new subscriber.
 *   • `POST /broadcast`    — fan-out a capacity update to all subscribers.
 *
 * CN.8.1 — Sprint 8 (real-time capacity).
 */

import type { AthlyaBindings } from '../types.js';
import type { DurableObjectState, WebSocket as CFWebSocket } from '@cloudflare/workers-types';

/**
 * Default subscriber cap per class DO (issue #141 / audit P6). A
 * hibernatable WebSocket is cheap, but a single hot class funnels
 * every subscriber onto one single-threaded isolate, so the broadcast
 * fan-out is O(subscribers) per booking and connection memory is
 * bounded by the DO. 500 keeps a large studio's most popular class
 * real-time while shedding pathological fan-in (bots, leaked tabs) to
 * polling. Tunable per environment via `CLASS_CAPACITY_MAX_WS`.
 */
export const DEFAULT_CLASS_CAPACITY_MAX_WS = 500;

function resolveMaxSubscribers(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CLASS_CAPACITY_MAX_WS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CLASS_CAPACITY_MAX_WS;
}

export class ClassCapacityDO {
  private readonly ctx: DurableObjectState;
  private readonly maxSubscribers: number;

  constructor(ctx: DurableObjectState, env: AthlyaBindings) {
    this.ctx = ctx;
    this.maxSubscribers = resolveMaxSubscribers(env.CLASS_CAPACITY_MAX_WS);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      // Shed load past the cap: a saturated single-isolate DO must not
      // accept unbounded fan-in. Excess clients fall back to polling
      // (`GET /v1/classes`) — see the `X-Capacity-Fallback` header.
      if (this.ctx.getWebSockets().length >= this.maxSubscribers) {
        return new Response(JSON.stringify({ error: 'capacity_do_saturated' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'X-Capacity-Fallback': 'poll',
            'Retry-After': '30',
          },
        });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server as unknown as CFWebSocket);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(request.url);
    if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
      const rawBody: unknown = await request.json();
      const body = rawBody as { remaining: number; classId: string };
      const message = JSON.stringify({
        type: 'capacity_update',
        classId: body.classId,
        remaining: body.remaining,
      });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // Client disconnected between getWebSockets() and send() — harmless.
        }
      }
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === 'ping') ws.send('pong');
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason);
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    ws.close(1011, 'Internal error');
  }
}
