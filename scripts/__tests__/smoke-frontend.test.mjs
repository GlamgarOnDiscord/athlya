import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runFrontendSmoke, SmokeError } from '../smoke-frontend.mjs';

const SECURE = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'nonce-W2hG6dJ4l5FvlJa2VZQkA' 'strict-dynamic'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=63072000',
};

function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path]();
    if (path === '/api/auth/refresh') return new Response('{}', { status: 401 });
    return new Response('ok', { status: 200, headers: SECURE });
  };
  return { impl, calls };
}

const quiet = () => {};

describe('runFrontendSmoke', () => {
  it('passes against healthy web, studio and API deployments', async () => {
    const { impl, calls } = fakeFetch();
    await runFrontendSmoke({
      webUrl: 'https://web.test',
      studioUrl: 'https://studio.test',
      apiUrl: 'https://api.test',
      fetchImpl: impl,
      log: quiet,
    });
    assert.ok(calls.some((c) => c.url === 'https://web.test/classes'));
    assert.ok(
      calls.some((c) => c.url === 'https://studio.test/api/auth/refresh' && c.method === 'POST'),
    );
    assert.ok(calls.some((c) => c.url === 'https://api.test/health'));
  });

  it('fails on a 5xx page', async () => {
    const { impl } = fakeFetch({ '/classes': () => new Response('boom', { status: 500 }) });
    await assert.rejects(
      runFrontendSmoke({ webUrl: 'https://web.test', fetchImpl: impl, log: quiet }),
      (err) => err instanceof SmokeError && /classes: HTTP 500/u.test(err.message),
    );
  });

  it('fails when the CSP lost its nonce', async () => {
    const { impl } = fakeFetch({
      '/login': () =>
        new Response('ok', {
          status: 200,
          headers: {
            ...SECURE,
            'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
          },
        }),
    });
    await assert.rejects(
      runFrontendSmoke({ webUrl: 'https://web.test', fetchImpl: impl, log: quiet }),
      /CSP without a per-request nonce/u,
    );
  });

  it('fails when the auth route handler crashes', async () => {
    const { impl } = fakeFetch({ '/api/auth/refresh': () => new Response('x', { status: 500 }) });
    await assert.rejects(
      runFrontendSmoke({ studioUrl: 'https://studio.test', fetchImpl: impl, log: quiet }),
      /anonymous refresh answered HTTP 500/u,
    );
  });

  it('fails on a network error and when no URL is configured', async () => {
    await assert.rejects(
      runFrontendSmoke({
        webUrl: 'https://web.test',
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
        log: quiet,
      }),
      /ECONNREFUSED/u,
    );
    await assert.rejects(runFrontendSmoke({ log: quiet }), /required/u);
  });
});
