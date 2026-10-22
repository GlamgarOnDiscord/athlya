/**
 * In-memory fake of the API and of the BFF auth routes for the studio
 * demo (issue #750). `routeStudioDemo` is a pure router over
 * {@link StudioDemoState}; `createDemoHandler` wires it to the browser
 * transport (`./transport.ts`) and keeps the state in `sessionStorage`
 * for the tab, so classes, branding and check-ins survive the full
 * reloads of the check-in route.
 */
import {
  NO_CONTENT,
  asRecord,
  browserSessionStorage,
  latency,
  loadState,
  notFound,
  ok,
  problem,
  saveState,
  toDemoRequest,
  toResponse,
  type DemoRequest,
  type DemoResponse,
  type DemoStorage,
} from './fake-http';
import {
  createStudioDemoState,
  demoId,
  type DemoClass,
  type DemoProgram,
  type DemoProgramWeek,
  type DemoUser,
  type StudioDemoState,
} from './fixtures';

export const STUDIO_DEMO_STORAGE_KEY = 'athlya.demo.studio';

export interface RouteResult {
  readonly state: StudioDemoState;
  readonly response: DemoResponse;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

function sessionUser(state: StudioDemoState): DemoUser | null {
  return state.users.find((u) => u.id === state.sessionUserId) ?? null;
}

function session(user: DemoUser): DemoResponse {
  return ok({
    accessToken: `demo-session-${user.role}`,
    accessTokenExpiresIn: 900,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      studioId: user.studioId,
      role: user.role,
    },
  });
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
    remaining: Math.max(0, c.capacity - c.booked),
  };
}

function publicUser(u: DemoUser): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    avatarUrl: u.avatarUrl,
    createdAt: u.createdAt,
  };
}

function programSummary(p: DemoProgram): Record<string, unknown> {
  return {
    id: p.id,
    studioId: p.studioId,
    title: p.title,
    description: p.description,
    status: p.status,
    version: p.version,
    weekCount: p.weekCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    archivedAt: p.archivedAt,
  };
}

function inRange(iso: string, query: URLSearchParams): boolean {
  const t = Date.parse(iso);
  const from = Date.parse(query.get('from') ?? '');
  const to = Date.parse(query.get('to') ?? '');
  return (Number.isNaN(from) || t >= from) && (Number.isNaN(to) || t <= to);
}

/** Cursor pagination over an in-memory list: the cursor is the next offset. */
function page<T>(
  items: readonly T[],
  query: URLSearchParams,
): { items: T[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '50', 10) || 50, 1), 100);
  const offset = Math.max(Number.parseInt(query.get('cursor') ?? '0', 10) || 0, 0);
  const slice = items.slice(offset, offset + limit);
  return {
    items: slice,
    nextCursor: offset + limit < items.length ? String(offset + limit) : null,
  };
}

function routeAuth(state: StudioDemoState, req: DemoRequest): RouteResult | null {
  if (req.method !== 'POST') return null;
  switch (req.path) {
    case '/api/auth/login': {
      const email = asRecord(req.body)['email'];
      const user = state.users.find((u) => u.email === email && u.role !== 'member');
      if (user === undefined) {
        return { state, response: problem(401, 'Unknown demo profile', 'invalid_credentials') };
      }
      return { state: { ...state, sessionUserId: user.id }, response: session(user) };
    }
    case '/api/auth/refresh': {
      const user = sessionUser(state);
      return {
        state,
        response: user === null ? problem(401, 'Unauthorized', 'unauthorized') : session(user),
      };
    }
    case '/api/auth/logout':
      return { state: { ...state, sessionUserId: null }, response: NO_CONTENT };
    default:
      return null;
  }
}

function forbidden(state: StudioDemoState): RouteResult {
  return { state, response: problem(403, 'Forbidden', 'forbidden') };
}

function readClassInput(body: unknown): Partial<DemoClass> {
  const input = asRecord(body);
  const out: Record<string, unknown> = {};
  if (typeof input['title'] === 'string' && input['title'].trim() !== '')
    out['title'] = input['title'].trim();
  if (typeof input['startsAt'] === 'string' && !Number.isNaN(Date.parse(input['startsAt']))) {
    out['startsAt'] = new Date(input['startsAt']).toISOString();
  }
  if (typeof input['durationMin'] === 'number') out['durationMin'] = input['durationMin'];
  if (typeof input['capacity'] === 'number') out['capacity'] = input['capacity'];
  if (typeof input['coachId'] === 'string' || input['coachId'] === null)
    out['coachId'] = input['coachId'];
  return out as Partial<DemoClass>;
}

function createClass(state: StudioDemoState, body: unknown, now: Date): RouteResult {
  const input = readClassInput(body);
  if (input.title === undefined || input.startsAt === undefined) {
    return { state, response: problem(400, 'Invalid class', 'validation_error') };
  }
  const created: DemoClass = {
    id: demoId('0c', 9000 + state.sequence),
    studioId: state.studio.id,
    coachId: input.coachId ?? null,
    title: input.title,
    startsAt: input.startsAt,
    durationMin: input.durationMin ?? 60,
    capacity: input.capacity ?? 12,
    version: 0,
    createdAt: now.toISOString(),
    booked: 0,
  };
  return {
    state: { ...state, sequence: state.sequence + 1, classes: [...state.classes, created] },
    response: ok(publicClass(created), 201),
  };
}

function updateClass(state: StudioDemoState, id: string, body: unknown): RouteResult {
  const existing = state.classes.find((c) => c.id === id);
  if (existing === undefined) return { state, response: problem(404, 'Class not found') };
  const version = asRecord(body)['version'];
  if (typeof version === 'number' && version !== existing.version) {
    return { state, response: problem(409, 'Class changed meanwhile', 'version_conflict') };
  }
  const input = readClassInput(body);
  const capacity = Math.max(input.capacity ?? existing.capacity, 1);
  const updated: DemoClass = {
    ...existing,
    ...input,
    capacity,
    booked: Math.min(existing.booked, capacity),
    version: existing.version + 1,
  };
  return {
    state: { ...state, classes: state.classes.map((c) => (c.id === id ? updated : c)) },
    response: ok(publicClass(updated)),
  };
}

function checkIn(state: StudioDemoState, body: unknown, now: Date): RouteResult {
  const token = asRecord(body)['qrToken'];
  if (typeof token !== 'string' || token.trim() === '') {
    return { state, response: problem(400, 'Malformed token', 'malformed') };
  }
  if (state.checkins.some((c) => c.token === token.trim())) {
    return { state, response: problem(409, 'Token already used', 'replay') };
  }
  const members = state.users.filter((u) => u.role === 'member');
  const member = members[state.checkins.length % members.length];
  if (member === undefined) return { state, response: problem(404, 'No member', 'malformed') };
  const reservationId = demoId('0e', 5000 + state.checkins.length + 1);
  return {
    state: {
      ...state,
      checkins: [
        ...state.checkins,
        { token: token.trim(), reservationId, memberId: member.id, at: now.toISOString() },
      ],
    },
    response: ok({
      success: true,
      reservationId,
      member: { id: member.id, displayName: member.displayName, avatarUrl: member.avatarUrl },
    }),
  };
}

function readWeeks(raw: unknown, programIndex: number): DemoProgramWeek[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((week, w) => {
    const record = asRecord(week);
    const workouts = Array.isArray(record['workouts']) ? record['workouts'] : [];
    return {
      weekNumber: typeof record['weekNumber'] === 'number' ? record['weekNumber'] : w + 1,
      title: typeof record['title'] === 'string' ? record['title'] : null,
      workouts: workouts.map((workout, d) => {
        const item = asRecord(workout);
        return {
          id: demoId('0b2', programIndex * 1000 + w * 10 + d + 1),
          dayNumber: typeof item['dayNumber'] === 'number' ? item['dayNumber'] : d + 1,
          title: typeof item['title'] === 'string' ? item['title'] : '',
          notes: typeof item['notes'] === 'string' ? item['notes'] : null,
          exercises: Array.isArray(item['exercises'])
            ? (item['exercises'] as DemoProgram['weeks'][number]['workouts'][number]['exercises'])
            : [],
        };
      }),
    };
  });
}

function saveProgram(
  state: StudioDemoState,
  id: string | null,
  body: unknown,
  now: Date,
): RouteResult {
  const input = asRecord(body);
  const existing = id === null ? undefined : state.programs.find((p) => p.id === id);
  if (id !== null && existing === undefined) {
    return { state, response: problem(404, 'Program not found') };
  }
  const index =
    existing === undefined
      ? state.programs.length + state.sequence
      : state.programs.indexOf(existing);
  const weeks = readWeeks(input['weeks'], index) ?? existing?.weeks ?? [];
  const status =
    input['status'] === 'published' || input['status'] === 'draft' ? input['status'] : undefined;
  const program: DemoProgram = {
    id: existing?.id ?? demoId('0b', 100 + state.sequence),
    studioId: state.studio.id,
    title: typeof input['title'] === 'string' ? input['title'] : (existing?.title ?? ''),
    description:
      typeof input['description'] === 'string' || input['description'] === null
        ? (input['description'] as string | null)
        : (existing?.description ?? null),
    status: status ?? existing?.status ?? 'draft',
    version: existing === undefined ? 0 : existing.version + 1,
    weekCount: weeks.length,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
    weeks,
  };
  const programs =
    existing === undefined
      ? [...state.programs, program]
      : state.programs.map((p) => (p.id === program.id ? program : p));
  return {
    state: { ...state, programs, sequence: state.sequence + 1 },
    response: ok({ ...programSummary(program), weeks }, existing === undefined ? 201 : 200),
  };
}

function patchStudio(state: StudioDemoState, body: unknown): RouteResult {
  const input = asRecord(body);
  const name = input['name'];
  const brandColor = input['brandColor'];
  const brandLogo = input['brandLogo'];
  const studio = {
    ...state.studio,
    ...(typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {}),
    ...(typeof brandColor === 'string' && HEX_COLOR.test(brandColor) ? { brandColor } : {}),
    ...(typeof brandLogo === 'string' || brandLogo === null ? { brandLogo } : {}),
  };
  return { state: { ...state, studio }, response: ok(studio) };
}

function routeApi(
  state: StudioDemoState,
  user: DemoUser,
  req: DemoRequest,
  now: Date,
): RouteResult {
  const { method, path, query } = req;
  const same = (response: DemoResponse): RouteResult => ({ state, response });
  const admin = user.role === 'admin';

  if (path === '/v1/studios/me') {
    if (method === 'GET') return same(ok(state.studio));
    if (method === 'PATCH') return admin ? patchStudio(state, req.body) : forbidden(state);
  }
  if (path === '/v1/classes') {
    if (method === 'GET') {
      const items = state.classes
        .filter((c) => inRange(c.startsAt, query))
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
        .map(publicClass);
      return same(ok({ items }));
    }
    if (method === 'POST') return admin ? createClass(state, req.body, now) : forbidden(state);
  }
  const classMatch = /^\/v1\/classes\/([^/]+)$/u.exec(path);
  if (classMatch?.[1] !== undefined) {
    const id = decodeURIComponent(classMatch[1]);
    if (!admin) return forbidden(state);
    if (method === 'PATCH') return updateClass(state, id, req.body);
    if (method === 'DELETE') {
      return {
        state: { ...state, classes: state.classes.filter((c) => c.id !== id) },
        response: NO_CONTENT,
      };
    }
  }
  if (method === 'GET' && path === '/v1/members') {
    return same(ok(page(state.users.map(publicUser), query)));
  }
  if (method === 'GET' && path === '/v1/audit') {
    if (!admin) return forbidden(state);
    const sorted = [...state.audit].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    return same(ok(page(sorted, query)));
  }
  if (method === 'POST' && path === '/v1/checkins') return checkIn(state, req.body, now);
  if (path === '/v1/programs') {
    if (method === 'GET') {
      const status = query.get('status');
      const items = state.programs
        .filter((p) => (status === null ? p.status !== 'archived' : p.status === status))
        .map(programSummary);
      return same(ok({ items }));
    }
    if (method === 'POST')
      return admin ? saveProgram(state, null, req.body, now) : forbidden(state);
  }
  const programMatch = /^\/v1\/programs\/([^/]+)(\/archive)?$/u.exec(path);
  if (programMatch?.[1] !== undefined) {
    const id = decodeURIComponent(programMatch[1]);
    const program = state.programs.find((p) => p.id === id);
    if (program === undefined) return same(problem(404, 'Program not found'));
    if (programMatch[2] !== undefined && method === 'POST') {
      if (!admin) return forbidden(state);
      const archived: DemoProgram = {
        ...program,
        status: 'archived',
        archivedAt: now.toISOString(),
        version: program.version + 1,
      };
      return {
        state: { ...state, programs: state.programs.map((p) => (p.id === id ? archived : p)) },
        response: ok(programSummary(archived)),
      };
    }
    if (programMatch[2] === undefined && method === 'GET') {
      return same(ok({ ...programSummary(program), weeks: program.weeks }));
    }
    if (programMatch[2] === undefined && method === 'PATCH') {
      return admin ? saveProgram(state, id, req.body, now) : forbidden(state);
    }
  }
  if (method === 'POST' && path === '/v1/billing/checkout') {
    return same(problem(409, 'Payments are not available in the demo', 'demo_not_available'));
  }
  return same(notFound());
}

/** Answers one request of the studio demo. Never touches the network. */
export function routeStudioDemo(state: StudioDemoState, req: DemoRequest, now: Date): RouteResult {
  if (req.path.startsWith('/api/auth/'))
    return routeAuth(state, req) ?? { state, response: notFound() };
  const user = sessionUser(state);
  if (user === null) return { state, response: problem(401, 'Unauthorized', 'unauthorized') };
  return routeApi(state, user, req, now);
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
    loadState<StudioDemoState>(storage, STUDIO_DEMO_STORAGE_KEY, 1) ?? createStudioDemoState(now());
  return async (request) => {
    const req = await toDemoRequest(request);
    await latency(delay);
    const result = routeStudioDemo(state, req, now());
    if (result.state !== state) {
      state = result.state;
      saveState(storage, STUDIO_DEMO_STORAGE_KEY, state);
    }
    return toResponse(result.response);
  };
}
