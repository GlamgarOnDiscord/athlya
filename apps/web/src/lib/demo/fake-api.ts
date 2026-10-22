/**
 * In-memory fake of the API and of the BFF auth routes for the member
 * demo (issue #750). `routeWebDemo` is a pure router over
 * {@link WebDemoState}; `createDemoHandler` wires it to the browser
 * transport (`./transport.ts`) and keeps the state in `sessionStorage`
 * for the tab, so bookings and profile edits survive a reload.
 */
import {
  NO_CONTENT,
  asRecord,
  browserSessionStorage,
  isBinaryBody,
  latency,
  loadState,
  notFound,
  ok,
  problem,
  saveState,
  toDataUrl,
  toDemoRequest,
  toResponse,
  type DemoRequest,
  type DemoResponse,
  type DemoStorage,
} from './fake-http';
import {
  COACH_DAILY_LIMIT,
  DEMO_COACH_ADVICE,
  createWebDemoState,
  demoCardio,
  demoId,
  demoProgression,
  type DemoClass,
  type DemoReservation,
  type WebDemoState,
} from './fixtures';

export const WEB_DEMO_STORAGE_KEY = 'athlya.demo.web';

/** Opaque, never a JWT: only the fake API reads it. */
export const DEMO_ACCESS_TOKEN = 'demo-session-member';

/**
 * Lower than the real API's 2 MiB: the avatar is saved as a base64 data URL
 * inside the tab's `sessionStorage` state, whose quota is about 5 MB.
 */
const MAX_AVATAR_BYTES = 512 * 1024;

/**
 * Host of the demo calendar feed. `.invalid` is reserved (RFC 2606), so a
 * calendar app given the demo URL can never subscribe to anything real.
 */
export const DEMO_CALENDAR_FEED_ORIGIN = 'https://calendar.athlya-demo.invalid';

export interface RouteResult {
  readonly state: WebDemoState;
  readonly response: DemoResponse;
}

function session(state: WebDemoState): DemoResponse {
  const { member } = state;
  return ok({
    accessToken: DEMO_ACCESS_TOKEN,
    accessTokenExpiresIn: 900,
    user: {
      id: member.id,
      email: member.email,
      displayName: member.displayName,
      studioId: member.studioId,
      role: member.role,
    },
  });
}

function remaining(c: DemoClass): number {
  return Math.max(0, c.capacity - c.booked);
}

function publicClass(c: DemoClass): Record<string, unknown> {
  return {
    id: c.id,
    studioId: c.studioId,
    coachId: c.coachId,
    title: c.title,
    startsAt: c.startsAt,
    durationMin: c.durationMin,
    capacity: c.capacity,
    version: c.version,
    createdAt: c.createdAt,
    remaining: remaining(c),
  };
}

function wireReservation(r: DemoReservation): Record<string, unknown> {
  return {
    id: r.id,
    classId: r.classId,
    userId: r.userId,
    status: r.status,
    createdAt: r.createdAt,
    cancelledAt: r.cancelledAt,
    checkedInAt: r.checkedInAt,
  };
}

function parseDate(raw: string | null): number | null {
  if (raw === null) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function inRange(iso: string, query: URLSearchParams): boolean {
  const t = Date.parse(iso);
  const from = parseDate(query.get('from'));
  const to = parseDate(query.get('to'));
  return (from === null || t >= from) && (to === null || t <= to);
}

function windowOf(query: URLSearchParams): 30 | 90 | 365 {
  const raw = query.get('window');
  return raw === '30' ? 30 : raw === '365' ? 365 : 90;
}

function nextUtcMidnight(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

/** Body of `GET /v1/calendar/feed-url`, shaped like the API's `CalendarFeedUrlResponse`. */
function calendarFeedUrl(state: WebDemoState): DemoResponse {
  const url = new URL('/v1/calendar/feed.ics', DEMO_CALENDAR_FEED_ORIGIN);
  url.searchParams.set('token', `demo-${state.member.id}`);
  const httpsUrl = url.toString();
  return ok({ httpsUrl, webcalUrl: httpsUrl.replace(/^https:/u, 'webcal:') });
}

function routeAuth(state: WebDemoState, req: DemoRequest): RouteResult | null {
  if (req.method !== 'POST') return null;
  switch (req.path) {
    case '/api/auth/login':
    case '/api/auth/register': {
      const next = { ...state, signedIn: true };
      return { state: next, response: session(next) };
    }
    case '/api/auth/refresh':
      return {
        state,
        response: state.signedIn ? session(state) : problem(401, 'Unauthorized', 'unauthorized'),
      };
    case '/api/auth/logout':
      return { state: { ...state, signedIn: false }, response: NO_CONTENT };
    case '/api/auth/password-reset/request':
      return { state, response: ok({ accepted: true }, 202) };
    case '/api/auth/password-reset/confirm':
      return { state, response: NO_CONTENT };
    default:
      return null;
  }
}

function book(state: WebDemoState, req: DemoRequest, now: Date): RouteResult {
  const classId = asRecord(req.body)['classId'];
  const target = state.classes.find((c) => c.id === classId);
  if (target === undefined) return { state, response: problem(404, 'Class not found') };
  if (Date.parse(target.startsAt) <= now.getTime()) {
    return { state, response: problem(422, 'Class already started', 'class_in_past') };
  }
  const active = state.reservations.find(
    (r) => r.classId === target.id && r.status !== 'cancelled',
  );
  if (active !== undefined) {
    return { state, response: problem(409, 'Already booked', 'already_booked') };
  }
  const full = remaining(target) === 0;
  const reservation: DemoReservation = {
    id: demoId('0e', state.sequence),
    classId: target.id,
    userId: state.member.id,
    status: full ? 'waitlist' : 'confirmed',
    position: full ? target.waitlisted + 1 : null,
    createdAt: now.toISOString(),
    cancelledAt: null,
    checkedInAt: null,
  };
  const next: WebDemoState = {
    ...state,
    sequence: state.sequence + 1,
    reservations: [...state.reservations, reservation],
    classes: state.classes.map((c) =>
      c.id !== target.id
        ? c
        : full
          ? { ...c, waitlisted: c.waitlisted + 1 }
          : { ...c, booked: c.booked + 1 },
    ),
  };
  const body = full
    ? {
        status: 'waitlist',
        reservation: wireReservation(reservation),
        position: reservation.position,
      }
    : { status: 'confirmed', reservation: wireReservation(reservation) };
  return { state: next, response: ok(body, full ? 202 : 201) };
}

function cancel(state: WebDemoState, reservationId: string, now: Date): RouteResult {
  const existing = state.reservations.find((r) => r.id === reservationId);
  if (existing === undefined) return { state, response: problem(404, 'Reservation not found') };
  if (existing.status === 'cancelled') {
    return {
      state,
      response: ok({
        status: 'cancelled',
        reservation: wireReservation(existing),
        alreadyCancelled: true,
      }),
    };
  }
  const cancelled: DemoReservation = {
    ...existing,
    status: 'cancelled',
    position: null,
    cancelledAt: now.toISOString(),
  };
  const next: WebDemoState = {
    ...state,
    reservations: state.reservations.map((r) => (r.id === existing.id ? cancelled : r)),
    classes: state.classes.map((c) =>
      c.id !== existing.classId
        ? c
        : existing.status === 'confirmed'
          ? { ...c, booked: Math.max(0, c.booked - 1) }
          : { ...c, waitlisted: Math.max(0, c.waitlisted - 1) },
    ),
  };
  return {
    state: next,
    response: ok({ status: 'cancelled', reservation: wireReservation(cancelled) }),
  };
}

function myReservations(state: WebDemoState, query: URLSearchParams): DemoResponse {
  const items = state.reservations.flatMap((r) => {
    const c = state.classes.find((k) => k.id === r.classId);
    if (c === undefined || !inRange(c.startsAt, query)) return [];
    return [
      {
        id: r.id,
        classId: r.classId,
        status: r.status,
        class: { title: c.title, startsAt: c.startsAt, durationMin: c.durationMin },
      },
    ];
  });
  return ok({ items, nextCursor: null });
}

function patchProfile(state: WebDemoState, body: unknown): RouteResult {
  const patch = asRecord(body);
  const displayName = patch['displayName'];
  const avatarUrl = patch['avatarUrl'];
  const member = {
    ...state.member,
    ...(typeof displayName === 'string' && displayName.trim() !== ''
      ? { displayName: displayName.trim() }
      : {}),
    ...(typeof avatarUrl === 'string' || avatarUrl === null ? { avatarUrl } : {}),
  };
  return { state: { ...state, member }, response: ok(member) };
}

function patchConsents(state: WebDemoState, body: unknown, now: Date): RouteResult {
  const patch = asRecord(body);
  const pick = (key: 'marketing' | 'analytics' | 'thirdParty'): boolean => {
    const value = patch[key];
    return typeof value === 'boolean' ? value : state.member.consents[key];
  };
  const consents = {
    ...state.member.consents,
    marketing: pick('marketing'),
    analytics: pick('analytics'),
    thirdParty: pick('thirdParty'),
    updatedAt: now.toISOString(),
  };
  return { state: { ...state, member: { ...state.member, consents } }, response: ok(consents) };
}

function uploadAvatar(state: WebDemoState, body: unknown): RouteResult {
  if (!isBinaryBody(body)) return { state, response: problem(400, 'Missing image') };
  if (body.bytes.byteLength > MAX_AVATAR_BYTES) {
    return { state, response: problem(413, 'Image too large', 'payload_too_large') };
  }
  const avatarUrl = toDataUrl(body);
  return {
    state: { ...state, member: { ...state.member, avatarUrl } },
    response: ok({ avatarUrl }),
  };
}

function askCoach(state: WebDemoState, body: unknown, now: Date): RouteResult {
  if (state.coachRemaining <= 0) {
    return { state, response: problem(429, 'Daily quota reached', 'coach_quota_exceeded') };
  }
  const coachRemaining = state.coachRemaining - 1;
  const advice = asRecord(body)['locale'] === 'en' ? DEMO_COACH_ADVICE.en : DEMO_COACH_ADVICE.fr;
  return {
    state: { ...state, coachRemaining },
    response: ok({
      advice,
      quota: {
        limit: COACH_DAILY_LIMIT,
        remaining: coachRemaining,
        resetsAt: nextUtcMidnight(now),
      },
      generatedAt: now.toISOString(),
    }),
  };
}

function routeApi(state: WebDemoState, req: DemoRequest, now: Date): RouteResult {
  const { method, path, query } = req;
  const same = (response: DemoResponse): RouteResult => ({ state, response });

  if (method === 'GET' && path === '/v1/classes') {
    const items = state.classes
      .filter((c) => inRange(c.startsAt, query))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .map(publicClass);
    return same(ok({ items }));
  }
  if (method === 'POST' && path === '/v1/reservations') return book(state, req, now);
  if (method === 'GET' && path === '/v1/reservations/me') return same(myReservations(state, query));
  const reservationMatch = /^\/v1\/reservations\/([^/]+)$/u.exec(path);
  if (method === 'DELETE' && reservationMatch?.[1] !== undefined) {
    return cancel(state, decodeURIComponent(reservationMatch[1]), now);
  }
  if (path === '/v1/members/me') {
    if (method === 'GET') return same(ok(state.member));
    if (method === 'PATCH') return patchProfile(state, req.body);
  }
  if (method === 'PATCH' && path === '/v1/members/me/consents') {
    return patchConsents(state, req.body, now);
  }
  if (method === 'PUT' && path === '/v1/members/me/avatar') return uploadAvatar(state, req.body);
  if (method === 'POST' && path === '/v1/members/me/export') {
    return same(ok({ jobId: demoId('0d', state.sequence) }, 202));
  }
  if (method === 'POST' && path === '/v1/auth/logout-all') {
    return { state: { ...state, signedIn: false }, response: NO_CONTENT };
  }
  if (method === 'DELETE' && path === '/v1/auth/me') {
    return { state: { ...state, signedIn: false }, response: NO_CONTENT };
  }
  if (method === 'POST' && path === '/v1/checkins/token') {
    return same(
      ok({
        token: `demo-checkin-${state.member.id.slice(-4)}-${now.getTime().toString(36)}`,
        expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      }),
    );
  }
  if (method === 'GET' && path === '/v1/coach') {
    return same(
      ok({
        enabled: true,
        thirdPartyConsent: state.member.consents.thirdParty,
        quota: {
          limit: COACH_DAILY_LIMIT,
          remaining: state.coachRemaining,
          resetsAt: nextUtcMidnight(now),
        },
      }),
    );
  }
  if (method === 'POST' && path === '/v1/coach/ask') return askCoach(state, req.body, now);
  if (method === 'GET' && path === '/v1/calendar/feed-url') return same(calendarFeedUrl(state));
  if (method === 'GET' && path === '/v1/me/progression') {
    return same(ok(demoProgression(now, windowOf(query))));
  }
  if (method === 'GET' && path === '/v1/me/progression/cardio') {
    return same(ok(demoCardio(now, windowOf(query))));
  }
  return same(notFound());
}

/** Answers one request of the member demo. Never touches the network. */
export function routeWebDemo(state: WebDemoState, req: DemoRequest, now: Date): RouteResult {
  if (req.path.startsWith('/api/auth/'))
    return routeAuth(state, req) ?? { state, response: notFound() };
  if (!state.signedIn) return { state, response: problem(401, 'Unauthorized', 'unauthorized') };
  return routeApi(state, req, now);
}

export interface DemoHandlerOptions {
  readonly storage?: DemoStorage | null;
  readonly now?: () => Date;
  readonly latencyMs?: number;
}

export function createDemoHandler(
  options: DemoHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const storage = options.storage === undefined ? browserSessionStorage() : options.storage;
  const now = options.now ?? (() => new Date());
  const delay = options.latencyMs ?? 150;
  let state =
    loadState<WebDemoState>(storage, WEB_DEMO_STORAGE_KEY, 1) ?? createWebDemoState(now());
  return async (request) => {
    const req = await toDemoRequest(request);
    await latency(delay);
    const result = routeWebDemo(state, req, now());
    if (result.state !== state) {
      state = result.state;
      saveState(storage, WEB_DEMO_STORAGE_KEY, state);
    }
    return toResponse(result.response);
  };
}
