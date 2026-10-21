/**
 * `/v1/calendar/*` (issue #719): the member's feed URL and the public,
 * token-authenticated iCalendar feed.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import {
  CALENDAR_FEED_CACHE_CONTROL,
  type CalendarDeps,
  type CalendarFeed,
  type CalendarFeedUrlResponse,
} from '../../routes/calendar.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  buildLocalResolver,
  buildStubDeps,
  env,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';

const joseHoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (joseHoisted.localResolver === null) {
          throw new Error('local resolver not initialised');
        }
        return joseHoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  joseHoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function auth(): Promise<Record<string, string>> {
  const token = await signTestJwt(kp.privateKey, {
    sub: TEST_USER_ID,
    studio: TEST_STUDIO_ID,
    role: 'member',
  });
  return { authorization: `Bearer ${token}` };
}

const FEED: CalendarFeed = {
  studioName: 'Studio Camille Durand',
  events: [
    {
      reservationId: 'aaaaaaaa-0000-4000-8000-000000000001',
      classTitle: 'Yoga, flow; débutants',
      startsAt: new Date('2026-10-21T18:00:00.000Z'),
      durationMin: 45,
      classVersion: 2,
      status: 'confirmed',
      updatedAt: new Date('2026-10-01T09:30:00.000Z'),
    },
    {
      reservationId: 'aaaaaaaa-0000-4000-8000-000000000002',
      classTitle: 'HIIT',
      startsAt: new Date('2026-10-22T07:00:00.000Z'),
      durationMin: 30,
      classVersion: 0,
      status: 'cancelled',
      updatedAt: new Date('2026-10-05T12:00:00.000Z'),
    },
  ],
};

function appWith(calendar: Partial<CalendarDeps>) {
  const deps = {
    ...buildStubDeps(),
    calendar: { getFeedUrl: vi.fn(), getFeed: vi.fn(), ...calendar },
  };
  return { app: buildApp({ deps }), calendar: deps.calendar };
}

describe('GET /v1/calendar/feed-url', () => {
  it('returns 401 without Authorization', async () => {
    const { app, calendar } = appWith({});
    const res = await app.request('/v1/calendar/feed-url', {}, env());
    expect(res.status).toBe(401);
    expect(calendar.getFeedUrl).not.toHaveBeenCalled();
  });

  it('returns the caller URLs and never lets them be cached', async () => {
    const urls = {
      httpsUrl: 'https://api.athlya.test/v1/calendar/feed.ics?token=abc.def',
      webcalUrl: 'webcal://api.athlya.test/v1/calendar/feed.ics?token=abc.def',
    };
    const getFeedUrl = vi.fn(async () => ({ kind: 'ok' as const, ...urls }));
    const { app } = appWith({ getFeedUrl });
    const res = await app.request('/v1/calendar/feed-url', { headers: await auth() }, env());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    await expect(readJson<CalendarFeedUrlResponse>(res)).resolves.toEqual(urls);
    expect(getFeedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
    );
  });

  it('answers 503 calendar_feed_not_configured without a signing key', async () => {
    const { app } = appWith({
      getFeedUrl: vi.fn(async () => ({ kind: 'not_configured' as const })),
    });
    const res = await app.request('/v1/calendar/feed-url', { headers: await auth() }, env());
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await readJson<{ code: string }>(res);
    expect(body.code).toBe('calendar_feed_not_configured');
  });
});

describe('GET /v1/calendar/feed.ics', () => {
  it('serves the feed as text/calendar with private short caching', async () => {
    const getFeed = vi.fn(async () => ({ kind: 'ok' as const, feed: FEED }));
    const { app } = appWith({ getFeed });
    const res = await app.request('/v1/calendar/feed.ics?token=abc.def', {}, env());

    expect(res.status).toBe(200);
    expect(getFeed).toHaveBeenCalledWith('abc.def');
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(CALENDAR_FEED_CACHE_CONTROL);
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/u);

    const body = await res.text();
    expect(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body).toContain('X-WR-CALNAME:Studio Camille Durand (Athlya)\r\n');
    expect(body).toContain('UID:reservation-aaaaaaaa-0000-4000-8000-000000000001@athlya.app\r\n');
    expect(body).toContain('SUMMARY:Yoga\\, flow\\; débutants\r\n');
    expect(body).toContain('LOCATION:Studio Camille Durand\r\n');
    expect(body).toContain('DTSTART:20261021T180000Z\r\nDTEND:20261021T184500Z\r\n');
    expect(body).toContain('DTSTAMP:20261001T093000Z\r\n');
    expect(body).toContain('STATUS:CONFIRMED\r\nSEQUENCE:2\r\n');
    // A cancellation bumps the sequence on top of the class version.
    expect(body).toContain('STATUS:CANCELLED\r\nSEQUENCE:1\r\n');
    expect(body).not.toContain(TEST_USER_ID);
  });

  it('answers 304 when the ETag still matches', async () => {
    const getFeed = vi.fn(async () => ({ kind: 'ok' as const, feed: FEED }));
    const { app } = appWith({ getFeed });
    const first = await app.request('/v1/calendar/feed.ics?token=abc.def', {}, env());
    const etag = first.headers.get('etag') ?? '';

    const second = await app.request(
      '/v1/calendar/feed.ics?token=abc.def',
      { headers: { 'if-none-match': etag } },
      env(),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('answers 404 for an unknown or revoked token, without telling why', async () => {
    const getFeed = vi.fn(async () => ({ kind: 'not_found' as const }));
    const { app } = appWith({ getFeed });
    const res = await app.request('/v1/calendar/feed.ics?token=forged.token', {}, env());
    expect(res.status).toBe(404);
    const body = await readJson<{ code: string }>(res);
    expect(body.code).toBe('not_found');
  });

  it('passes an empty token through when the parameter is missing', async () => {
    const getFeed = vi.fn(async () => ({ kind: 'not_found' as const }));
    const { app } = appWith({ getFeed });
    const res = await app.request('/v1/calendar/feed.ics', {}, env());
    expect(res.status).toBe(404);
    expect(getFeed).toHaveBeenCalledWith('');
  });

  it('answers 503 calendar_feed_not_configured without a signing key', async () => {
    const { app } = appWith({ getFeed: vi.fn(async () => ({ kind: 'not_configured' as const })) });
    const res = await app.request('/v1/calendar/feed.ics?token=abc.def', {}, env());
    expect(res.status).toBe(503);
    const body = await readJson<{ code: string }>(res);
    expect(body.code).toBe('calendar_feed_not_configured');
  });
});
