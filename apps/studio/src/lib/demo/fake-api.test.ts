import { describe, expect, it } from 'vitest';

import { STUDIO_DEMO_STORAGE_KEY, createDemoHandler, routeStudioDemo } from './fake-api';
import {
  DEMO_ADMIN_ID,
  DEMO_COACH_ID,
  createStudioDemoState,
  type StudioDemoState,
} from './fixtures';

import type { DemoRequest, DemoStorage } from './fake-http';

const NOW = new Date('2026-10-20T10:00:00.000Z');

function req(method: string, path: string, body?: unknown, query = ''): DemoRequest {
  return { method, path, query: new URLSearchParams(query), body };
}

function as(userId: string): StudioDemoState {
  return { ...createStudioDemoState(NOW), sessionUserId: userId };
}

describe('routeStudioDemo', () => {
  it('opens an admin or coach session from the demo profile email, never a member one', () => {
    const fresh = createStudioDemoState(NOW);
    expect(routeStudioDemo(fresh, req('GET', '/v1/studios/me'), NOW).response.status).toBe(401);

    const admin = routeStudioDemo(
      fresh,
      req('POST', '/api/auth/login', { email: 'camille.durand@example.com' }),
      NOW,
    );
    expect(admin.response.body).toMatchObject({
      user: { displayName: 'Camille Durand', role: 'admin' },
    });

    const coach = routeStudioDemo(
      fresh,
      req('POST', '/api/auth/login', { email: 'ines.garnier@example.com' }),
      NOW,
    );
    expect(coach.response.body).toMatchObject({
      user: { displayName: 'Inès Garnier', role: 'coach' },
    });

    const member = routeStudioDemo(
      fresh,
      req('POST', '/api/auth/login', { email: 'hugo.lefevre@example.com' }),
      NOW,
    );
    expect(member.response.status).toBe(401);

    const refresh = routeStudioDemo(coach.state, req('POST', '/api/auth/refresh'), NOW);
    expect(refresh.response.body).toMatchObject({ user: { role: 'coach' } });
  });

  it('serves the studio, the members and the audit trail', () => {
    const state = as(DEMO_ADMIN_ID);
    expect(routeStudioDemo(state, req('GET', '/v1/studios/me'), NOW).response.body).toMatchObject({
      name: 'Studio Rive Gauche',
    });
    const members = routeStudioDemo(state, req('GET', '/v1/members', undefined, 'limit=5'), NOW)
      .response.body as { items: unknown[]; nextCursor: string | null };
    expect(members.items).toHaveLength(5);
    expect(members.nextCursor).toBe('5');
    const audit = routeStudioDemo(state, req('GET', '/v1/audit', undefined, 'limit=50'), NOW)
      .response.body as { items: { createdAt: string }[] };
    expect(audit.items.length).toBeGreaterThan(0);
    const times = audit.items.map((i) => Date.parse(i.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('keeps the audit trail and class writes to the admin', () => {
    const state = as(DEMO_COACH_ID);
    expect(routeStudioDemo(state, req('GET', '/v1/audit'), NOW).response.status).toBe(403);
    expect(
      routeStudioDemo(
        state,
        req('POST', '/v1/classes', { title: 'X', startsAt: NOW.toISOString() }),
        NOW,
      ).response.status,
    ).toBe(403);
    const week = routeStudioDemo(
      state,
      req(
        'GET',
        '/v1/classes',
        undefined,
        `from=${NOW.toISOString()}&to=${new Date(NOW.getTime() + 7 * 86_400_000).toISOString()}`,
      ),
      NOW,
    ).response.body as { items: { coachId: string | null }[] };
    expect(week.items.some((c) => c.coachId === DEMO_COACH_ID)).toBe(true);
  });

  it('creates, edits with the version check, and deletes a class', () => {
    const startsAt = new Date(NOW.getTime() + 86_400_000).toISOString();
    const created = routeStudioDemo(
      as(DEMO_ADMIN_ID),
      req('POST', '/v1/classes', { title: 'Stretching', startsAt, durationMin: 30, capacity: 10 }),
      NOW,
    );
    expect(created.response.status).toBe(201);
    const id = (created.response.body as { id: string }).id;
    expect(created.response.body).toMatchObject({ remaining: 10, version: 0 });

    const stale = routeStudioDemo(
      created.state,
      req('PATCH', `/v1/classes/${id}`, { capacity: 8, version: 3 }),
      NOW,
    );
    expect(stale.response).toMatchObject({ status: 409, body: { code: 'version_conflict' } });

    const edited = routeStudioDemo(
      created.state,
      req('PATCH', `/v1/classes/${id}`, { capacity: 8, version: 0 }),
      NOW,
    );
    expect(edited.response.body).toMatchObject({ capacity: 8, version: 1 });

    const deleted = routeStudioDemo(edited.state, req('DELETE', `/v1/classes/${id}`), NOW);
    expect(deleted.response.status).toBe(204);
    expect(deleted.state.classes.some((c) => c.id === id)).toBe(false);
  });

  it('checks a member in from a manual token and refuses a replay', () => {
    const first = routeStudioDemo(
      as(DEMO_ADMIN_ID),
      req('POST', '/v1/checkins', { qrToken: 'abc' }),
      NOW,
    );
    expect(first.response.body).toMatchObject({
      success: true,
      member: { displayName: 'Hugo Lefèvre' },
    });
    const replay = routeStudioDemo(
      first.state,
      req('POST', '/v1/checkins', { qrToken: 'abc' }),
      NOW,
    );
    expect(replay.response).toMatchObject({ status: 409, body: { code: 'replay' } });
    const next = routeStudioDemo(first.state, req('POST', '/v1/checkins', { qrToken: 'def' }), NOW);
    expect(next.response.body).toMatchObject({ member: { displayName: 'Lucas Bertin' } });
  });

  it('updates the branding', () => {
    const result = routeStudioDemo(
      as(DEMO_ADMIN_ID),
      req('PATCH', '/v1/studios/me', { brandColor: '#1D4ED8' }),
      NOW,
    );
    expect(result.state.studio.brandColor).toBe('#1D4ED8');
  });

  it('answers an unknown route with a problem', () => {
    expect(routeStudioDemo(as(DEMO_ADMIN_ID), req('GET', '/v1/unknown'), NOW).response.status).toBe(
      404,
    );
  });
});

describe('createDemoHandler', () => {
  it('keeps the session across a reload of the page', async () => {
    const data = new Map<string, string>();
    const storage: DemoStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
    const handle = createDemoHandler({ storage, now: () => NOW, latencyMs: 0 });
    await handle(
      new Request('https://studio.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'camille.durand@example.com', password: 'demo' }),
      }),
    );
    expect(data.has(STUDIO_DEMO_STORAGE_KEY)).toBe(true);
    const reloaded = createDemoHandler({ storage, now: () => NOW, latencyMs: 0 });
    const studio = await reloaded(new Request('https://api.test/v1/studios/me'));
    expect(studio.status).toBe(200);
  });
});
