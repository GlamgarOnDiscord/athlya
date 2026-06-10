import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { compress } from 'hono/compress';

// ~2014 bytes — large enough to trigger compression regardless of threshold.
const LARGE_PAYLOAD = { data: 'x'.repeat(2000) };

// Small payload — used to document that Workers/Fetch responses from c.json()
// do NOT set Content-Length, so Hono's 1 KB threshold guard is bypassed and
// small bodies are compressed too when Accept-Encoding is present.
const SMALL_PAYLOAD = { ok: true };

// A strong ETag value (without W/ prefix).
const STRONG_ETAG = '"abc123def456"';

function buildTestApp(): Hono {
  const app = new Hono();
  app.use('*', compress());
  app.get('/large', (c) => c.json(LARGE_PAYLOAD));
  app.get('/small', (c) => c.json(SMALL_PAYLOAD));
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

  // Workers/Fetch responses from c.json() do not emit Content-Length, so
  // Hono's built-in 1 KB threshold guard does not fire. Small JSON bodies
  // are therefore also compressed when Accept-Encoding is present.
  it('compresses a small c.json() response because Content-Length is absent', async () => {
    const app = buildTestApp();
    const res = await app.request('/small', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
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
