import { describe, expect, it } from 'vitest';

import {
  DEMO_ACCESS_TOKEN,
  DEMO_CALENDAR_FEED_ORIGIN,
  WEB_DEMO_STORAGE_KEY,
  createDemoHandler,
  routeWebDemo,
} from './fake-api';
import { createWebDemoState, type WebDemoState } from './fixtures';

import type { DemoRequest, DemoStorage } from './fake-http';

const NOW = new Date('2026-10-20T10:00:00.000Z');

function req(method: string, path: string, body?: unknown, query = ''): DemoRequest {
  return { method, path, query: new URLSearchParams(query), body };
}

function signedIn(): WebDemoState {
  return { ...createWebDemoState(NOW), signedIn: true };
}

function memoryStorage(): DemoStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('routeWebDemo', () => {
  it('refuses the API before a demo sign-in and opens a session on login', () => {
    const fresh = createWebDemoState(NOW);
    expect(routeWebDemo(fresh, req('GET', '/v1/members/me'), NOW).response.status).toBe(401);
    expect(routeWebDemo(fresh, req('POST', '/api/auth/refresh'), NOW).response.status).toBe(401);

    const login = routeWebDemo(
      fresh,
      req('POST', '/api/auth/login', { email: 'x', password: 'y' }),
      NOW,
    );
    expect(login.response.status).toBe(200);
    expect(login.response.body).toMatchObject({
      accessToken: DEMO_ACCESS_TOKEN,
      user: { displayName: 'Léa Fontaine', role: 'member' },
    });
    expect(routeWebDemo(login.state, req('POST', '/api/auth/refresh'), NOW).response.status).toBe(
      200,
    );

    const logout = routeWebDemo(login.state, req('POST', '/api/auth/logout'), NOW);
    expect(logout.response.status).toBe(204);
    expect(logout.state.signedIn).toBe(false);
  });

  it('caps the avatar so the saved demo state stays within sessionStorage', () => {
    const state = signedIn();
    const upload = (size: number) =>
      routeWebDemo(
        state,
        req('PUT', '/v1/members/me/avatar', {
          contentType: 'image/png',
          bytes: new Uint8Array(size),
        }),
        NOW,
      );
    expect(upload(512 * 1024 + 1).response.status).toBe(413);
    const accepted = upload(1024);
    expect(accepted.response.status).toBe(200);
    expect(accepted.state.member.avatarUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it('lists classes in the requested range with the remaining seats', () => {
    const state = signedIn();
    const from = NOW.toISOString();
    const to = new Date(NOW.getTime() + 2 * 86_400_000).toISOString();
    const { response } = routeWebDemo(
      state,
      req('GET', '/v1/classes', undefined, `from=${from}&to=${to}`),
      NOW,
    );
    const items = (
      response.body as { items: { startsAt: string; remaining: number; capacity: number }[] }
    ).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Date.parse(item.startsAt)).toBeGreaterThanOrEqual(Date.parse(from));
      expect(Date.parse(item.startsAt)).toBeLessThanOrEqual(Date.parse(to));
      expect(item.remaining).toBeLessThanOrEqual(item.capacity);
      expect(item).not.toHaveProperty('booked');
    }
  });

  it('books a free class, takes a seat, then cancels it and gives the seat back', () => {
    const state = signedIn();
    const target = state.classes.find(
      (c) =>
        Date.parse(c.startsAt) > NOW.getTime() &&
        c.booked < c.capacity &&
        !state.reservations.some((r) => r.classId === c.id),
    );
    expect(target).toBeDefined();
    const booked = routeWebDemo(
      state,
      req('POST', '/v1/reservations', { classId: target?.id }),
      NOW,
    );
    expect(booked.response.status).toBe(201);
    expect(booked.response.body).toMatchObject({ status: 'confirmed' });
    expect(booked.state.classes.find((c) => c.id === target?.id)?.booked).toBe(
      (target?.booked ?? 0) + 1,
    );

    const again = routeWebDemo(
      booked.state,
      req('POST', '/v1/reservations', { classId: target?.id }),
      NOW,
    );
    expect(again.response.status).toBe(409);

    const reservation = booked.state.reservations.at(-1);
    const cancelled = routeWebDemo(
      booked.state,
      req('DELETE', `/v1/reservations/${reservation?.id ?? ''}`),
      NOW,
    );
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.state.classes.find((c) => c.id === target?.id)?.booked).toBe(target?.booked);

    const mine = routeWebDemo(
      cancelled.state,
      req('GET', '/v1/reservations/me', undefined, `from=${NOW.toISOString()}`),
      NOW,
    );
    const items = (mine.response.body as { items: { id: string; status: string }[] }).items;
    expect(items.find((i) => i.id === reservation?.id)?.status).toBe('cancelled');
  });

  it('puts a full class on the waitlist with a position', () => {
    const state = signedIn();
    const full = state.classes.find(
      (c) =>
        Date.parse(c.startsAt) > NOW.getTime() &&
        c.booked >= c.capacity &&
        !state.reservations.some((r) => r.classId === c.id),
    );
    expect(full).toBeDefined();
    const result = routeWebDemo(state, req('POST', '/v1/reservations', { classId: full?.id }), NOW);
    expect(result.response.status).toBe(202);
    expect(result.response.body).toMatchObject({
      status: 'waitlist',
      position: (full?.waitlisted ?? 0) + 1,
    });
  });

  it('refuses a class that already started', () => {
    const state = signedIn();
    const past = state.classes.find((c) => Date.parse(c.startsAt) < NOW.getTime());
    const result = routeWebDemo(state, req('POST', '/v1/reservations', { classId: past?.id }), NOW);
    expect(result.response).toMatchObject({ status: 422, body: { code: 'class_in_past' } });
  });

  it('edits the profile and the consents', () => {
    const state = signedIn();
    const renamed = routeWebDemo(
      state,
      req('PATCH', '/v1/members/me', { displayName: ' Léa F. ' }),
      NOW,
    );
    expect(renamed.state.member.displayName).toBe('Léa F.');
    const consents = routeWebDemo(
      renamed.state,
      req('PATCH', '/v1/members/me/consents', { marketing: true }),
      NOW,
    );
    expect(consents.state.member.consents.marketing).toBe(true);
    expect(
      routeWebDemo(consents.state, req('GET', '/v1/members/me'), NOW).response.body,
    ).toMatchObject({
      displayName: 'Léa F.',
      consents: { marketing: true },
    });
  });

  it('spends the coach quota and refuses once it is empty', () => {
    let state: WebDemoState = { ...signedIn(), coachRemaining: 1 };
    const first = routeWebDemo(
      state,
      req('POST', '/v1/coach/ask', { question: 'Squat ?', locale: 'fr' }),
      NOW,
    );
    expect(first.response.body).toMatchObject({ quota: { remaining: 0 } });
    state = first.state;
    const second = routeWebDemo(state, req('POST', '/v1/coach/ask', { question: 'Squat ?' }), NOW);
    expect(second.response).toMatchObject({ status: 429, body: { code: 'coach_quota_exceeded' } });
  });

  it('signs out everywhere like a sign-out, and the BFF sign-out still answers after', () => {
    const all = routeWebDemo(signedIn(), req('POST', '/v1/auth/logout-all', {}), NOW);
    expect(all.response.status).toBe(204);
    expect(all.state.signedIn).toBe(false);
    expect(routeWebDemo(all.state, req('GET', '/v1/members/me'), NOW).response.status).toBe(401);
    expect(routeWebDemo(all.state, req('POST', '/api/auth/logout'), NOW).response.status).toBe(204);
    expect(routeWebDemo(all.state, req('POST', '/api/auth/refresh'), NOW).response.status).toBe(
      401,
    );
  });

  it('answers the privacy settings: export job, then account deletion ends the session', () => {
    const state = signedIn();
    const exported = routeWebDemo(state, req('POST', '/v1/members/me/export', {}), NOW);
    expect(exported.response.status).toBe(202);
    expect(exported.response.body).toMatchObject({ jobId: expect.any(String) });
    const deleted = routeWebDemo(state, req('DELETE', '/v1/auth/me'), NOW);
    expect(deleted.response.status).toBe(204);
    expect(deleted.state.signedIn).toBe(false);
  });

  it('gives a calendar feed URL on a reserved host that nothing real answers', () => {
    const state = signedIn();
    const { response } = routeWebDemo(state, req('GET', '/v1/calendar/feed-url'), NOW);
    expect(response.status).toBe(200);
    const body = response.body as { httpsUrl: string; webcalUrl: string };
    expect(Object.keys(body).sort()).toEqual(['httpsUrl', 'webcalUrl']);

    const https = new URL(body.httpsUrl);
    expect(https.origin).toBe(DEMO_CALENDAR_FEED_ORIGIN);
    expect(https.hostname.endsWith('.invalid')).toBe(true);
    expect(https.pathname).toBe('/v1/calendar/feed.ics');
    expect(https.searchParams.get('token')).toBe(`demo-${state.member.id}`);
    expect(body.webcalUrl).toBe(body.httpsUrl.replace(/^https:/u, 'webcal:'));

    const signedOut = createWebDemoState(NOW);
    expect(routeWebDemo(signedOut, req('GET', '/v1/calendar/feed-url'), NOW).response.status).toBe(
      401,
    );
  });

  it('answers an unknown route with a problem, not a network call', () => {
    const { response } = routeWebDemo(signedIn(), req('GET', '/v1/unknown'), NOW);
    expect(response).toMatchObject({ status: 404, body: { code: 'demo_not_available' } });
  });
});

describe('createDemoHandler', () => {
  it('answers a Request as JSON and keeps the state in storage', async () => {
    const storage = memoryStorage();
    const handle = createDemoHandler({ storage, now: () => NOW, latencyMs: 0 });
    const login = await handle(
      new Request('https://web.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.c', password: 'demo' }),
      }),
    );
    expect(login.status).toBe(200);
    expect(login.headers.get('content-type')).toContain('json');
    expect(storage.data.has(WEB_DEMO_STORAGE_KEY)).toBe(true);

    const reloaded = createDemoHandler({ storage, now: () => NOW, latencyMs: 0 });
    const me = await reloaded(new Request('https://api.test/v1/members/me'));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { displayName: string }).displayName).toBe('Léa Fontaine');

    const logout = await reloaded(
      new Request('https://web.test/api/auth/logout', { method: 'POST' }),
    );
    expect(logout.status).toBe(204);
  });
});
