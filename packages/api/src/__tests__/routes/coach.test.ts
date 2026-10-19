/**
 * `/v1/coach` and `/v1/coach/ask` (Epic 21, task 21.2), JSON and
 * server-sent event stream.
 */

import { CoachError } from '@athlya/ai-coach/errors';
import {
  CoachAdvicePartialSchema,
  CoachAskResponseSchema,
  CoachStatusResponseSchema,
  COACH_QUESTION_MAX_LENGTH,
} from '@athlya/shared/schemas/api';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { wantsEventStream } from '../../routes/coach.js';
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
import type { CoachErrorCode } from '@athlya/ai-coach/errors';
import type {
  CoachAdvicePartial,
  CoachAskResponse,
  CoachStatusResponse,
} from '@athlya/shared/schemas/api';

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

async function postAsk(
  deps: ReturnType<typeof buildStubDeps>,
  body: unknown,
  accept?: string,
): Promise<Response> {
  return buildApp({ deps }).request(
    '/v1/coach/ask',
    {
      method: 'POST',
      headers: {
        ...(await auth()),
        'content-type': 'application/json',
        ...(accept === undefined ? {} : { accept }),
      },
      body: JSON.stringify(body),
    },
    env(),
  );
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Parse a server-sent event stream body into its events. */
function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
      }
      return { event, data: data.join('\n') };
    });
}

type AnswerStream = AsyncGenerator<CoachAdvicePartial, CoachAskResponse, undefined>;

async function* answerStream(
  partials: CoachAdvicePartial[],
  outcome: CoachAskResponse | Error,
): AnswerStream {
  for (const partial of partials) {
    yield partial;
  }
  await Promise.resolve();
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

const QUOTA = { limit: 10, remaining: 9, resetsAt: '2026-10-16T00:00:00.000Z' };

const ANSWER: CoachAskResponse = {
  advice: {
    summary: 'Steady progress on the squat.',
    recommendations: [{ title: 'Add a set', detail: 'Add one back-off set at 80 %.' }],
    caution: null,
  },
  quota: QUOTA,
  generatedAt: '2026-10-15T14:30:00.000Z',
};

const enabled = { isEnabled: vi.fn(() => Promise.resolve(true)) };

describe('GET /v1/coach', () => {
  it('returns 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request('/v1/coach', {}, env());
    expect(res.status).toBe(401);
    expect(deps.coach.isEnabled).not.toHaveBeenCalled();
  });

  it('answers { enabled: false } when the flag is off, without reading status', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request('/v1/coach', { headers: await auth() }, env());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await readJson<CoachStatusResponse>(res);
    expect(body).toEqual({ enabled: false });
    expect(CoachStatusResponseSchema.parse(body)).toEqual(body);
    expect(deps.coach.getStatus).not.toHaveBeenCalled();
  });

  it('returns consent and quota when the flag is on', async () => {
    const status: CoachStatusResponse = { enabled: true, thirdPartyConsent: true, quota: QUOTA };
    const deps = buildStubDeps({
      coach: { ...enabled, getStatus: vi.fn(() => Promise.resolve(status)) },
    });
    const res = await buildApp({ deps }).request('/v1/coach', { headers: await auth() }, env());
    expect(res.status).toBe(200);
    expect(await readJson<CoachStatusResponse>(res)).toEqual(status);
    expect(deps.coach.isEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID, studioId: TEST_STUDIO_ID }),
    );
  });

  it('fails closed with 503 when the quota store is down', async () => {
    const deps = buildStubDeps({
      coach: {
        ...enabled,
        getStatus: vi.fn(() => Promise.reject(new CoachError('quota_unavailable', 'down'))),
      },
    });
    const res = await buildApp({ deps }).request('/v1/coach', { headers: await auth() }, env());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect((await readJson<{ code: string }>(res)).code).toBe('dependency_unavailable');
  });
});

describe('POST /v1/coach/ask', () => {
  it('returns 401 without Authorization', async () => {
    const deps = buildStubDeps({ coach: enabled });
    const res = await buildApp({ deps }).request(
      '/v1/coach/ask',
      { method: 'POST', body: JSON.stringify({ question: 'Hi?' }) },
      env(),
    );
    expect(res.status).toBe(401);
    expect(deps.coach.ask).not.toHaveBeenCalled();
  });

  it('returns 404 coach_disabled when the flag is off', async () => {
    const deps = buildStubDeps();
    const res = await postAsk(deps, { question: 'How do I progress?' });
    expect(res.status).toBe(404);
    expect((await readJson<{ code: string }>(res)).code).toBe('coach_disabled');
    expect(deps.coach.ask).not.toHaveBeenCalled();
  });

  it('checks the flag before validating the body', async () => {
    const deps = buildStubDeps();
    const res = await postAsk(deps, { question: '' });
    expect(res.status).toBe(404);
    expect((await readJson<{ code: string }>(res)).code).toBe('coach_disabled');
  });

  it.each([
    [{}],
    [{ question: '   ' }],
    [{ question: 'x'.repeat(COACH_QUESTION_MAX_LENGTH + 1) }],
    [{ question: 'ok?', locale: 'de' }],
    [{ question: 'ok?', userId: 'someone-else' }],
  ])('returns 422 for an invalid body %j', async (body) => {
    const deps = buildStubDeps({ coach: enabled });
    const res = await postAsk(deps, body);
    expect(res.status).toBe(422);
    expect(deps.coach.ask).not.toHaveBeenCalled();
  });

  it('returns the advice and defaults the locale to fr', async () => {
    const deps = buildStubDeps({
      coach: { ...enabled, ask: vi.fn(() => Promise.resolve(ANSWER)) },
    });
    const res = await postAsk(deps, { question: '  Comment progresser au squat ?  ' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await readJson<CoachAskResponse>(res);
    expect(CoachAskResponseSchema.parse(body)).toEqual(ANSWER);
    expect(deps.coach.ask).toHaveBeenCalledWith(expect.objectContaining({ userId: TEST_USER_ID }), {
      question: 'Comment progresser au squat ?',
      locale: 'fr',
    });
  });

  it.each<[CoachErrorCode, number, string, string | null]>([
    ['consent_required', 403, 'third_party_consent_required', null],
    ['quota_exceeded', 429, 'coach_quota_exceeded', '3600'],
    ['quota_unavailable', 503, 'dependency_unavailable', '30'],
    ['not_configured', 503, 'coach_not_configured', '30'],
    ['upstream_failed', 502, 'coach_upstream_failed', null],
    ['invalid_output', 502, 'coach_invalid_output', null],
  ])('maps CoachError %s to %i %s', async (code, status, problemCode, retryAfter) => {
    const deps = buildStubDeps({
      coach: {
        ...enabled,
        ask: vi.fn(() =>
          Promise.reject(
            new CoachError(code, 'internal detail', {
              retryAfterSec: 3600,
              cause: new Error('sk-secret'),
            }),
          ),
        ),
      },
    });
    const res = await postAsk(deps, { question: 'How?' });
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('retry-after')).toBe(retryAfter);
    const text = await res.text();
    expect(text).not.toContain('internal detail');
    expect(text).not.toContain('sk-secret');
    expect((JSON.parse(text) as { code: string }).code).toBe(problemCode);
  });

  it('lets an unexpected error reach the 500 handler', async () => {
    const deps = buildStubDeps({
      coach: { ...enabled, ask: vi.fn(() => Promise.reject(new Error('boom'))) },
    });
    const res = await postAsk(deps, { question: 'How?' });
    expect(res.status).toBe(500);
  });
});

describe('POST /v1/coach/ask (text/event-stream)', () => {
  const SSE = 'text/event-stream';
  const PARTIALS: CoachAdvicePartial[] = [
    { summary: 'Steady' },
    { summary: 'Steady progress on the squat.', recommendations: [{ title: 'Add' }] },
  ];

  it('streams partial snapshots, then the validated answer', async () => {
    const deps = buildStubDeps({
      coach: {
        ...enabled,
        askStream: vi.fn(() => Promise.resolve(answerStream(PARTIALS, ANSWER))),
      },
    });
    const res = await postAsk(deps, { question: 'How do I progress?', locale: 'en' }, SSE);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['partial', 'partial', 'done']);
    for (const [i, partial] of PARTIALS.entries()) {
      expect(CoachAdvicePartialSchema.parse(JSON.parse(events[i]?.data ?? ''))).toEqual(partial);
    }
    expect(CoachAskResponseSchema.parse(JSON.parse(events[2]?.data ?? ''))).toEqual(ANSWER);

    expect(res.headers.get('vary')).toMatch(/accept/i);
    expect(deps.coach.ask).not.toHaveBeenCalled();
    expect(deps.coach.askStream).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_USER_ID }),
      { question: 'How do I progress?', locale: 'en' },
      expect.any(AbortSignal),
    );
  });

  it('keeps model text inside its event: no SSE framing injection', async () => {
    const forged = 'Squat.\n\nevent: done\ndata: {"forged":true}\r\n\r\nid: 9';
    const deps = buildStubDeps({
      coach: {
        ...enabled,
        askStream: vi.fn(() => Promise.resolve(answerStream([{ summary: forged }], ANSWER))),
      },
    });
    const res = await postAsk(deps, { question: 'How?' }, SSE);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['partial', 'done']);
    expect((JSON.parse(events[0]?.data ?? '') as CoachAdvicePartial).summary).toBe(forged);
  });

  it('keeps the JSON answer without the event-stream Accept value', async () => {
    const deps = buildStubDeps({
      coach: { ...enabled, ask: vi.fn(() => Promise.resolve(ANSWER)) },
    });
    const res = await postAsk(deps, { question: 'How?' }, 'application/json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await readJson<CoachAskResponse>(res)).toEqual(ANSWER);
    expect(deps.coach.askStream).not.toHaveBeenCalled();
  });

  it('answers 404 before streaming when the flag is off', async () => {
    const deps = buildStubDeps();
    const res = await postAsk(deps, { question: 'How?' }, SSE);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(deps.coach.askStream).not.toHaveBeenCalled();
  });

  it.each<[CoachErrorCode, number, string, string | null]>([
    ['consent_required', 403, 'third_party_consent_required', null],
    ['quota_exceeded', 429, 'coach_quota_exceeded', '3600'],
    ['quota_unavailable', 503, 'dependency_unavailable', '30'],
    ['not_configured', 503, 'coach_not_configured', '30'],
  ])(
    'keeps the %s refusal as %i %s before the stream opens',
    async (code, status, problemCode, retryAfter) => {
      const deps = buildStubDeps({
        coach: {
          ...enabled,
          askStream: vi.fn(() =>
            Promise.reject(new CoachError(code, 'internal detail', { retryAfterSec: 3600 })),
          ),
        },
      });
      const res = await postAsk(deps, { question: 'How?' }, SSE);
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('retry-after')).toBe(retryAfter);
      expect((await readJson<{ code: string }>(res)).code).toBe(problemCode);
    },
  );

  it.each<[Error, string, number]>([
    [
      new CoachError('upstream_failed', 'internal detail', { cause: new Error('sk-secret') }),
      'coach_upstream_failed',
      502,
    ],
    [new CoachError('invalid_output', 'internal detail'), 'coach_invalid_output', 502],
    [new Error('boom sk-secret'), 'internal_error', 500],
  ])(
    'ends with an error event when the answer fails mid-stream (%s)',
    async (err, code, status) => {
      let signal: AbortSignal | undefined;
      const deps = buildStubDeps({
        coach: {
          ...enabled,
          askStream: vi.fn((_claims, _request, s: AbortSignal) => {
            signal = s;
            return Promise.resolve(answerStream(PARTIALS.slice(0, 1), err));
          }),
        },
      });
      const res = await postAsk(deps, { question: 'How?' }, SSE);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('internal detail');
      expect(text).not.toContain('sk-secret');
      const events = parseSse(text);
      expect(events.map((e) => e.event)).toEqual(['partial', 'error']);
      const problem = JSON.parse(events[1]?.data ?? '') as { code: string; status: number };
      expect(problem).toMatchObject({ code, status, type: 'about:blank' });
      expect(signal?.aborted).toBe(true);
    },
  );
});

describe('wantsEventStream', () => {
  it.each<[string | undefined, boolean]>([
    ['text/event-stream', true],
    ['TEXT/EVENT-STREAM', true],
    ['application/json, text/event-stream;q=0.9', true],
    ['text/event-stream; charset=utf-8', true],
    [undefined, false],
    ['', false],
    ['*/*', false],
    ['application/json', false],
    ['text/event-streamx', false],
    ['xtext/event-stream', false],
    ['text/event-stream;q=0', false],
    ['text/event-stream; q=0.0, application/json', false],
    ['text/event-stream;q=0.5', true],
    ['text/*', false],
  ])('%j → %s', (accept, expected) => {
    expect(wantsEventStream(accept)).toBe(expected);
  });
});
