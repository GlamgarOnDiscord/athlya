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

import type { DurableObjectState, WebSocket as CFWebSocket } from '@cloudflare/workers-types';
import type { AthlyaBindings } from '../types.js';

export class ClassCapacityDO {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: AthlyaBindings) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server as unknown as CFWebSocket);
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(request.url);
    if (url.pathname.endsWith('/broadcast') && request.method === 'POST') {
      const body = (await request.json()) as { remaining: number; classId: string };
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
