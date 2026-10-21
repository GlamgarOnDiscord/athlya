/**
 * `/v1/calendar/*` router: the member's iCalendar subscription feed
 * (issue #719, `docs/architecture/calendar-feed.md`).
 *
 *   | Method | Path                   | Chain                                  |
 *   |--------|------------------------|----------------------------------------|
 *   | GET    | /feed-url              | jwtAuth → studioRateLimit → handler    |
 *   | GET    | /feed.ics?token=<t>    | handler (the signed token is the auth) |
 *
 * Both paths also run behind the gateway's fail-closed `calendar-feed`
 * IP limiter (`base-app.ts`). The feed is served on the API apex host,
 * where the `/v1/*` tenant claim guard has no slug to check, so calendar
 * clients reach it without a JWT. Mounted on the monolith gateway only.
 *
 * The token travels in the query string, not the path: the serve log,
 * the OTel span and the Sentry tags record the pathname only, so the
 * credential never reaches application logs.
 *
 * The feed lists the member's confirmed and cancelled bookings; waitlist
 * entries are left out because the seat is not theirs yet (a promotion
 * turns the row into a confirmed booking, which the next poll picks up).
 */

import {
  ATHLYA_ICS_PRODUCT_ID,
  ICS_CONTENT_TYPE,
  reservationEventUid,
  serializeIcs,
  type IcsCalendar,
} from '@athlya/shared/calendar';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';

import { computeListEtag, traceOperation } from './helpers.js';
import { ifNoneMatchHits } from './me.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type { Context } from 'hono';

/** One booking as the feed shows it. */
export interface CalendarFeedEvent {
  readonly reservationId: string;
  readonly classTitle: string;
  readonly startsAt: Date;
  readonly durationMin: number;
  /** `classes.version`, bumped on every class update. */
  readonly classVersion: number;
  readonly status: 'confirmed' | 'cancelled';
  /** Last change of the booking: its cancellation, else its creation. */
  readonly updatedAt: Date;
}

export interface CalendarFeed {
  readonly studioName: string;
  readonly events: readonly CalendarFeedEvent[];
}

export type CalendarFeedUrlOutcome =
  | { readonly kind: 'ok'; readonly httpsUrl: string; readonly webcalUrl: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_configured' };

export type CalendarFeedOutcome =
  | { readonly kind: 'ok'; readonly feed: CalendarFeed }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_configured' };

/** Dependencies injected into {@link buildCalendarRouter}. */
export interface CalendarDeps {
  getFeedUrl(claims: AuthClaims): Promise<CalendarFeedUrlOutcome>;
  getFeed(token: string): Promise<CalendarFeedOutcome>;
}

/** Body of `GET /v1/calendar/feed-url`. */
export interface CalendarFeedUrlResponse {
  readonly httpsUrl: string;
  readonly webcalUrl: string;
}

/** `Cache-Control` of the feed: per subscriber, refreshed every 5 minutes at most. */
export const CALENDAR_FEED_CACHE_CONTROL = 'private, max-age=300';

/** Polling hint written into the feed (`REFRESH-INTERVAL`). */
export const CALENDAR_FEED_REFRESH_MINUTES = 60;

/** Path of the public feed under `/v1/calendar`; the token is the `token` query parameter. */
export const CALENDAR_FEED_FILE = '/feed.ics';

const PROBLEM_JSON = 'application/problem+json';
const MS_PER_MINUTE = 60_000;

function problem(c: Context<HonoEnv>, status: 404 | 503, detail: string, code: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: status === 503 ? 'Service Unavailable' : 'Not Found',
      status,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    status,
    { 'content-type': PROBLEM_JSON, 'cache-control': 'no-store' },
  );
}

const notConfigured = (c: Context<HonoEnv>): Response =>
  problem(c, 503, 'Calendar feeds are not configured', 'calendar_feed_not_configured');

/** Map the feed to an iCalendar object; exported for the serializer tests. */
export function toIcsCalendar(feed: CalendarFeed): IcsCalendar {
  return {
    prodId: ATHLYA_ICS_PRODUCT_ID,
    name: `${feed.studioName} (Athlya)`,
    refreshIntervalMinutes: CALENDAR_FEED_REFRESH_MINUTES,
    events: feed.events.map((event) => ({
      uid: reservationEventUid(event.reservationId),
      start: event.startsAt,
      end: new Date(event.startsAt.getTime() + event.durationMin * MS_PER_MINUTE),
      stamp: event.updatedAt,
      summary: event.classTitle,
      location: feed.studioName,
      status: event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
      // A cancellation is a revision of its own, on top of class edits.
      sequence: event.classVersion + (event.status === 'cancelled' ? 1 : 0),
    })),
  };
}

/** Build the `/v1/calendar/*` sub-router. */
export function buildCalendarRouter(deps: CalendarDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();

  // The public feed below authenticates with its token, so only this
  // path sits behind `jwtAuth()`.
  router.use('/feed-url', jwtAuth());
  router.use('/feed-url', studioRateLimit() as Parameters<typeof router.use>[1]);

  router.get('/feed-url', async (c) => {
    traceOperation(c, 'calendar.feed-url');
    const claims = c.get('authClaims');
    if (claims === undefined) {
      throw new Error('authClaims unexpectedly missing after jwtAuth');
    }
    const outcome = await deps.getFeedUrl(claims);
    switch (outcome.kind) {
      case 'not_configured':
        return notConfigured(c);
      case 'not_found':
        return problem(c, 404, 'Member not found', 'not_found');
      case 'ok': {
        // The URL is a bearer credential: never cache it anywhere.
        c.header('cache-control', 'private, no-store');
        const body: CalendarFeedUrlResponse = {
          httpsUrl: outcome.httpsUrl,
          webcalUrl: outcome.webcalUrl,
        };
        return c.json(body, 200);
      }
    }
  });

  router.get(CALENDAR_FEED_FILE, async (c) => {
    traceOperation(c, 'calendar.feed');
    const token = c.req.query('token') ?? '';
    const outcome = await deps.getFeed(token);
    switch (outcome.kind) {
      case 'not_configured':
        return notConfigured(c);
      case 'not_found':
        return problem(c, 404, 'Calendar feed not found', 'not_found');
      case 'ok': {
        const body = serializeIcs(toIcsCalendar(outcome.feed));
        const etag = await computeListEtag(body);
        c.header('etag', etag);
        c.header('cache-control', CALENDAR_FEED_CACHE_CONTROL);
        c.header('x-robots-tag', 'noindex');
        if (ifNoneMatchHits(c.req.header('if-none-match'), etag)) {
          return c.body(null, 304);
        }
        return c.body(body, 200, {
          'content-type': ICS_CONTENT_TYPE,
          'content-disposition': 'inline; filename="athlya.ics"',
        });
      }
    }
  });

  return router;
}
