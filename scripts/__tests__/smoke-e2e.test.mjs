import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runBookingFlow } from '../smoke-e2e-login-booking.mjs';

const NOW = new Date('2026-10-12T10:00:00Z');

function json(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function api(overrides = {}) {
  const calls = [];
  const routes = {
    'POST /v1/auth/login': () => json(200, { accessToken: 'tok' }),
    'GET /v1/classes': () =>
      json(200, {
        items: [
          { id: 'past', remaining: 3, startsAt: '2026-10-11T10:00:00Z' },
          { id: 'full', remaining: 0, startsAt: '2026-10-13T10:00:00Z' },
          { id: 'open', remaining: 2, startsAt: '2026-10-14T10:00:00Z' },
        ],
      }),
    'POST /v1/reservations': () => json(201, { status: 'confirmed', reservation: { id: 'r1' } }),
    'DELETE /v1/reservations/r1': () => json(200, { status: 'cancelled' }),
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    calls.push({ key, url, headers: init.headers, body: init.body });
    const handler = routes[key];
    return handler ? handler(init) : json(404, {});
  };
  return { calls, fetchImpl };
}

const base = {
  baseUrl: 'https://staging.example',
  email: 'smoke@example.com',
  password: 'secret',
  studioSlug: 'smoke-studio',
  now: () => NOW,
  log: () => {},
};

describe('runBookingFlow', () => {
  it('logs in, books the first upcoming class with seats, then cancels it', async () => {
    const { calls, fetchImpl } = api();
    const result = await runBookingFlow({ ...base, fetchImpl });

    assert.equal(result.ok, true);
    assert.deepEqual(
      calls.map((c) => c.key),
      [
        'POST /v1/auth/login',
        'GET /v1/classes',
        'POST /v1/reservations',
        'DELETE /v1/reservations/r1',
      ],
    );
    const booking = calls[2];
    assert.deepEqual(JSON.parse(booking.body), { classId: 'open' });
    assert.equal(booking.headers.authorization, 'Bearer tok');
    assert.equal(booking.headers['x-studio-slug'], 'smoke-studio');
    assert.ok(booking.headers['idempotency-key']);
  });

  it('lists classes over the API maximum 90-day window', async () => {
    const { calls, fetchImpl } = api();
    await runBookingFlow({ ...base, fetchImpl });

    const query = new URL(calls[1].url).searchParams;
    assert.equal(query.get('from'), '2026-10-12T10:00:00.000Z');
    assert.equal(query.get('to'), '2027-01-10T10:00:00.000Z');
  });

  it('reuses a provided session instead of logging in again', async () => {
    const { calls, fetchImpl } = api();
    const result = await runBookingFlow({ ...base, accessToken: 'shared', fetchImpl });

    assert.equal(result.ok, true);
    assert.equal(result.steps[0], 'reuse session');
    assert.ok(!calls.some((c) => c.key === 'POST /v1/auth/login'));
    assert.equal(calls[0].headers.authorization, 'Bearer shared');
  });

  it('skips a class already booked by a concurrent run and books the next one', async () => {
    const { calls, fetchImpl } = api({
      'GET /v1/classes': () =>
        json(200, {
          items: [
            { id: 'taken', remaining: 1, startsAt: '2026-10-13T10:00:00Z' },
            { id: 'open', remaining: 2, startsAt: '2026-10-14T10:00:00Z' },
          ],
        }),
      'POST /v1/reservations': (init) =>
        JSON.parse(init.body).classId === 'taken'
          ? json(409, { status: 'confirmed', reservation: { id: 'other-run' } })
          : json(201, { status: 'confirmed', reservation: { id: 'r1' } }),
    });
    const result = await runBookingFlow({ ...base, fetchImpl });

    assert.equal(result.ok, true);
    assert.ok(!calls.some((c) => c.key === 'DELETE /v1/reservations/other-run'));
    assert.equal(calls.at(-1).key, 'DELETE /v1/reservations/r1');
  });

  it('cancels the reservation when stopped right after booking', async () => {
    const { calls, fetchImpl } = api();
    let stop = false;
    const result = await runBookingFlow({
      ...base,
      fetchImpl: async (url, init) => {
        const res = await fetchImpl(url, init);
        if (init.method === 'POST' && url.endsWith('/v1/reservations')) stop = true;
        return res;
      },
      shouldStop: () => stop,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /interrupted/);
    assert.equal(calls.at(-1).key, 'DELETE /v1/reservations/r1');
  });

  it('warns with the reservation id when cleanup after a failure is rejected', async () => {
    const lines = [];
    let stop = false;
    const { fetchImpl } = api({
      'POST /v1/reservations': () => {
        stop = true;
        return json(201, { status: 'confirmed', reservation: { id: 'r1' } });
      },
      'DELETE /v1/reservations/r1': () => json(500, {}),
    });
    const result = await runBookingFlow({
      ...base,
      fetchImpl,
      shouldStop: () => stop,
      log: (line) => lines.push(line),
    });

    assert.equal(result.ok, false);
    assert.ok(lines.some((line) => /WARN .*cancel reservation r1 manually/.test(line)));
  });

  it('fails when login is rejected and books nothing', async () => {
    const { calls, fetchImpl } = api({ 'POST /v1/auth/login': () => json(401, {}) });
    const result = await runBookingFlow({ ...base, fetchImpl });

    assert.equal(result.ok, false);
    assert.match(result.error, /login/);
    assert.equal(calls.length, 1);
  });

  it('fails when no upcoming class has a free seat', async () => {
    const { fetchImpl } = api({
      'GET /v1/classes': () =>
        json(200, { items: [{ id: 'full', remaining: 0, startsAt: '2026-10-13T10:00:00Z' }] }),
    });
    const result = await runBookingFlow({ ...base, fetchImpl });

    assert.equal(result.ok, false);
    assert.match(result.error, /no upcoming class/);
  });

  it('reports a failed cancel', async () => {
    const { fetchImpl } = api({ 'DELETE /v1/reservations/r1': () => json(500, {}) });
    const result = await runBookingFlow({ ...base, fetchImpl });

    assert.equal(result.ok, false);
    assert.match(result.error, /cancel/);
  });

  it('accepts a waitlisted booking and still cancels it', async () => {
    const { calls, fetchImpl } = api({
      'POST /v1/reservations': () =>
        json(202, { status: 'waitlist', reservation: { id: 'r1' }, position: 1 }),
    });
    const result = await runBookingFlow({ ...base, fetchImpl });

    assert.equal(result.ok, true);
    assert.equal(calls.at(-1).key, 'DELETE /v1/reservations/r1');
  });
});
