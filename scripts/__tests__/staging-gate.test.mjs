import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateCheckRuns, requireCheckSuccess } from '../require-check-success.mjs';
import { runSmoke } from '../smoke-routes.mjs';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes requests to handlers keyed by `METHOD path`, defaulting to 401. */
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    const key = `${init.method} ${pathname}`;
    calls.push({ key, url, headers: init.headers, body: init.body });
    const handler = routes[key];
    return handler ? handler(init) : jsonResponse(401);
  };
}

const healthy = {
  'GET /health/ready': () => jsonResponse(200, { status: 'ok' }),
};

describe('runSmoke', () => {
  it('passes the public pass when nothing returns 5xx', async () => {
    const result = await runSmoke({
      baseUrl: 'https://staging.example',
      fetchImpl: fakeFetch(healthy),
      log: () => {},
    });
    assert.equal(result.ok, true);
  });

  it('fails on a 5xx route group', async () => {
    const result = await runSmoke({
      baseUrl: 'https://staging.example',
      fetchImpl: fakeFetch({ ...healthy, 'GET /v1/classes': () => jsonResponse(502) }),
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /classes\.list/);
  });

  it('fails when --require-auth is set without credentials', async () => {
    const result = await runSmoke({
      baseUrl: 'https://staging.example',
      requireAuth: true,
      fetchImpl: fakeFetch(healthy),
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /auth\.credentials/);
  });

  it('logs in and requires 200 on authenticated routes', async () => {
    const calls = [];
    const routes = {
      ...healthy,
      'POST /v1/auth/login': (init) =>
        JSON.parse(init.body).email ? jsonResponse(200, { accessToken: 'tok' }) : jsonResponse(422),
      'GET /v1/members/me': (init) =>
        init.headers.authorization === 'Bearer tok' ? jsonResponse(200, {}) : jsonResponse(401),
      'GET /v1/reservations/me': (init) =>
        init.headers.authorization === 'Bearer tok' ? jsonResponse(200, {}) : jsonResponse(401),
    };
    const result = await runSmoke({
      baseUrl: 'https://staging.example',
      email: 'smoke@example.com',
      password: 'secret',
      turnstileToken: 'XXXX',
      requireAuth: true,
      fetchImpl: fakeFetch(routes, calls),
      log: () => {},
    });
    assert.deepEqual(result.failures, []);
    const login = calls.find((c) => c.key === 'POST /v1/auth/login' && c.body?.includes('smoke@'));
    assert.equal(login.headers['cf-turnstile-token'], 'XXXX');
  });

  it('lists studio classes over a bounded range and returns the session token', async () => {
    const calls = [];
    const authed = (init) =>
      init.headers.authorization === 'Bearer tok' ? jsonResponse(200, {}) : jsonResponse(401);
    const routes = {
      ...healthy,
      'POST /v1/auth/login': () => jsonResponse(200, { accessToken: 'tok' }),
      'GET /v1/members/me': authed,
      'GET /v1/reservations/me': authed,
      'GET /v1/classes': authed,
    };
    const result = await runSmoke({
      baseUrl: 'https://staging.example',
      email: 'smoke@example.com',
      password: 'secret',
      studioSlug: 'smoke-studio',
      now: () => new Date('2026-10-12T10:00:00Z'),
      fetchImpl: fakeFetch(routes, calls),
      log: () => {},
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.accessToken, 'tok');
    const list = calls.find((c) => c.key === 'GET /v1/classes' && c.headers.authorization);
    const query = new URL(list.url).searchParams;
    assert.equal(query.get('from'), '2026-10-12T10:00:00.000Z');
    assert.equal(query.get('to'), '2027-01-10T10:00:00.000Z');
  });

  it('fails when an authenticated route does not return 200', async () => {
    const routes = {
      ...healthy,
      'POST /v1/auth/login': () => jsonResponse(200, { accessToken: 'tok' }),
      'GET /v1/members/me': () => jsonResponse(200, {}),
      'GET /v1/reservations/me': () => jsonResponse(500),
    };
    const result = await runSmoke({
      baseUrl: 'https://staging.example',
      email: 'smoke@example.com',
      password: 'secret',
      fetchImpl: fakeFetch(routes),
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /reservations\.me/);
  });
});

describe('evaluateCheckRuns', () => {
  const run = (conclusion, completedAt) => ({
    name: 'Staging gate',
    status: 'completed',
    conclusion,
    completed_at: completedAt,
  });

  it('accepts the latest successful run', () => {
    const result = evaluateCheckRuns(
      [run('failure', '2026-10-01T10:00:00Z'), run('success', '2026-10-01T11:00:00Z')],
      'Staging gate',
    );
    assert.equal(result.ok, true);
  });

  it('rejects when the latest run failed even if an older one passed', () => {
    const result = evaluateCheckRuns(
      [run('success', '2026-10-01T10:00:00Z'), run('failure', '2026-10-01T11:00:00Z')],
      'Staging gate',
    );
    assert.equal(result.ok, false);
  });

  it('rejects when no run exists or it is still in progress', () => {
    assert.equal(evaluateCheckRuns([], 'Staging gate').ok, false);
    assert.equal(
      evaluateCheckRuns(
        [{ name: 'Staging gate', status: 'in_progress', conclusion: null, completed_at: null }],
        'Staging gate',
      ).ok,
      false,
    );
  });
});

describe('requireCheckSuccess', () => {
  it('fails closed when the GitHub API errors', async () => {
    const result = await requireCheckSuccess({
      repo: 'o/r',
      sha: 'abc',
      checkName: 'Staging gate',
      token: 't',
      fetchImpl: async () => jsonResponse(403),
    });
    assert.equal(result.ok, false);
  });
});
