import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { compress } from 'hono/compress';

// A body large enough to exceed the 1 KB threshold.
// JSON.stringify wraps it in {"data":"xxx..."} — ~2014 bytes total.
const LARGE_PAYLOAD = { data: 'x'.repeat(2000) };

// A body small enough to stay below the 1 KB threshold.
const SMALL_PAYLOAD = { ok: true };

// A strong ETag value (without W/ prefix).
const STRONG_ETAG = '"abc123def456"';

function buildTestApp(): Hono {
  const app = new Hono();
  app.use('*', compress());
  app.get('/large', (c) => c.json(LARGE_PAYLOAD));
  app.get('/small', (c) => {
    // Explicitly set Content-Length so the compress() threshold check fires.
    // Without it, Hono's test harness does not add Content-Length, and the
    // middleware's `contentLength && contentLength < 1024` guard is skipped.
    const body = JSON.stringify(SMALL_PAYLOAD);
    return c.body(body, 200, {
      'content-type': 'application/json',
      'content-length': String(body.length),
    });
  });
  app.get('/etag', (c) => {
    // c.header() must be called before c.json() so the header is included
    // in the Response created by newResponse().
    c.header('ETag', STRONG_ETAG);
    return c.json(LARGE_PAYLOAD);
  });
  return app;
}

describe('compress middleware', () => {
  it('sets Content-Encoding: gzip on a large response when Accept-Encoding: gzip', async () => {
    const app = buildTestApp();
    const res = await app.request('/large', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('sets Content-Encoding: deflate when Accept-Encoding: deflate', async () => {
    const app = buildTestApp();
    const res = await app.request('/large', {
      headers: { 'accept-encoding': 'deflate' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('deflate');
  });

  it('does not set Content-Encoding when Accept-Encoding is absent', async () => {
    const app = buildTestApp();
    const res = await app.request('/large');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('does not compress a response below the 1 KB threshold', async () => {
    const app = buildTestApp();
    const res = await app.request('/small', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('weakens a strong ETag to a weak ETag when compressing (RFC 7232)', async () => {
    const app = buildTestApp();
    const res = await app.request('/etag', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('etag')).toBe(`W/${STRONG_ETAG}`);
  });

  it('decompresses gzip body back to the original JSON', async () => {
    const app = buildTestApp();
    const res = await app.request('/large', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const ds = new DecompressionStream('gzip');
    const decompressed = res.body!.pipeThrough(ds);
    const text = await new Response(decompressed).text();
    expect(JSON.parse(text)).toEqual(LARGE_PAYLOAD);
  });
});
