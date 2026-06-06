/**
 * Unit tests for ClassCapacityDO (CN.8.1).
 *
 * The Cloudflare DO runtime is not available in Vitest, so we wire a
 * minimal stub for `DurableObjectState` that exposes the Hibernation
 * WebSocket API surface (`acceptWebSocket` / `getWebSockets`).
 *
 * `WebSocketPair` is a Cloudflare Workers global — not available in
 * Node.js — so we polyfill it at the module level.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ClassCapacityDO,
  DEFAULT_CLASS_CAPACITY_MAX_WS,
} from '../../durable-objects/class-capacity.js';

/* ------------------------------------------------------------------ */
/*  Cloudflare Workers globals polyfill                                */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof g['WebSocketPair'] === 'undefined') {
    class MockWebSocket {
      send = vi.fn();
      close = vi.fn();
      readyState = 1;
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      dispatchEvent = vi.fn();
    }
    class MockWebSocketPair {
      0: MockWebSocket;
      1: MockWebSocket;
      constructor() {
        this[0] = new MockWebSocket();
        this[1] = new MockWebSocket();
      }
    }
    g['WebSocketPair'] = MockWebSocketPair;
  }
});

/* ------------------------------------------------------------------ */
/*  Minimal stubs                                                      */
/* ------------------------------------------------------------------ */

function makeWebSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as unknown as WebSocket;
}

function makeCtx(sockets: WebSocket[] = []) {
  const registered: WebSocket[] = [];
  return {
    acceptWebSocket: vi.fn((ws: WebSocket) => registered.push(ws)),
    getWebSockets: vi.fn(() => [...registered, ...sockets]),
    _registered: registered,
  } as unknown as import('@cloudflare/workers-types').DurableObjectState & {
    _registered: WebSocket[];
  };
}

function makeEnv(maxWs?: string) {
  return (
    maxWs === undefined ? {} : { CLASS_CAPACITY_MAX_WS: maxWs }
  ) as import('../../types.js').AthlyaBindings;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ClassCapacityDO', () => {
  it('accepts a WebSocket upgrade and registers the server socket', async () => {
    const ctx = makeCtx();
    const do_ = new ClassCapacityDO(ctx, makeEnv());

    const req = new Request('https://worker.dev/ws', {
      headers: { Upgrade: 'websocket' },
    });

    // `new Response(null, { status: 101 })` is rejected by the Node.js
    // fetch implementation but is valid in the Cloudflare Workers runtime.
    // We only assert the DO-level behaviour (socket registered) here.
    try {
      await do_.fetch(req);
    } catch {
      // Node.js rejects status 101 — expected in test environment.
    }
    expect(ctx.acceptWebSocket).toHaveBeenCalledOnce();
  });

  it('broadcasts to all connected WebSockets on POST /broadcast', async () => {
    const ws1 = makeWebSocket();
    const ws2 = makeWebSocket();
    const ctx = makeCtx([ws1, ws2]);
    const do_ = new ClassCapacityDO(ctx, makeEnv());

    const req = new Request('https://worker.dev/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classId: 'cls-1', remaining: 3 }),
    });

    const res = await do_.fetch(req);
    expect(res.status).toBe(204);

    const expected = JSON.stringify({ type: 'capacity_update', classId: 'cls-1', remaining: 3 });
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);
  });

  it('returns 404 for unknown paths', async () => {
    const do_ = new ClassCapacityDO(makeCtx(), makeEnv());
    const req = new Request('https://worker.dev/unknown');
    const res = await do_.fetch(req);
    expect(res.status).toBe(404);
  });

  it('replies pong to ping WebSocket messages', () => {
    const ws = makeWebSocket();
    const do_ = new ClassCapacityDO(makeCtx(), makeEnv());
    do_.webSocketMessage(ws, 'ping');
    expect(ws.send).toHaveBeenCalledWith('pong');
  });

  it('ignores non-ping WebSocket messages', () => {
    const ws = makeWebSocket();
    const do_ = new ClassCapacityDO(makeCtx(), makeEnv());
    do_.webSocketMessage(ws, 'hello');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('closes the WebSocket on webSocketClose', () => {
    const ws = makeWebSocket();
    const do_ = new ClassCapacityDO(makeCtx(), makeEnv());
    do_.webSocketClose(ws, 1000, 'Normal');
    expect(ws.close).toHaveBeenCalledWith(1000, 'Normal');
  });

  it('closes the WebSocket with 1011 on webSocketError', () => {
    const ws = makeWebSocket();
    const do_ = new ClassCapacityDO(makeCtx(), makeEnv());
    do_.webSocketError(ws, new Error('boom'));
    expect(ws.close).toHaveBeenCalledWith(1011, 'Internal error');
  });

  it('sheds new upgrades past the subscriber cap with 503 + poll fallback (issue #141)', async () => {
    const existing = Array.from({ length: 2 }, () => makeWebSocket());
    const ctx = makeCtx(existing);
    const do_ = new ClassCapacityDO(ctx, makeEnv('2'));

    const req = new Request('https://worker.dev/ws', { headers: { Upgrade: 'websocket' } });
    const res = await do_.fetch(req);

    expect(res.status).toBe(503);
    expect(res.headers.get('X-Capacity-Fallback')).toBe('poll');
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it('falls back to the default cap on absent/invalid CLASS_CAPACITY_MAX_WS', async () => {
    // One subscriber, default cap (500) → upgrade still accepted.
    const ctx = makeCtx([makeWebSocket()]);
    const do_ = new ClassCapacityDO(ctx, makeEnv('not-a-number'));
    expect(DEFAULT_CLASS_CAPACITY_MAX_WS).toBe(500);

    const req = new Request('https://worker.dev/ws', { headers: { Upgrade: 'websocket' } });
    try {
      await do_.fetch(req);
    } catch {
      // Node rejects status 101 — we only assert the socket was accepted.
    }
    expect(ctx.acceptWebSocket).toHaveBeenCalledOnce();
  });

  it('skips faulted WebSockets during broadcast without throwing', async () => {
    const faulted = makeWebSocket();
    (faulted.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('WebSocket closed');
    });
    const ctx = makeCtx([faulted]);
    const do_ = new ClassCapacityDO(ctx, makeEnv());

    const makeReq = () =>
      new Request('https://worker.dev/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId: 'cls-1', remaining: 0 }),
      });

    const res = await do_.fetch(makeReq());
    expect(res.status).toBe(204);
  });
});
