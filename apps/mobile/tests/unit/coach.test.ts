import { describe, expect, it, vi } from 'vitest';

import {
  COACH_ASK_PATH,
  COACH_STATUS_PATH,
  CoachController,
  isCoachEnabled,
} from '../../features/coach/coach-controller';
import {
  createApiClient,
  type ApiClient,
  type StreamResponse,
} from '../../infrastructure/api/client';
import { AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';
import { flush } from '../features-helpers';

import type { CoachAskResponse, CoachStatusResponse } from '@athlya/shared/schemas/api';

const QUOTA = { limit: 10, remaining: 4, resetsAt: '2026-10-20T00:00:00.000Z' };
const ENABLED: CoachStatusResponse = { enabled: true, thirdPartyConsent: true, quota: QUOTA };

const ANSWER: CoachAskResponse = {
  advice: {
    summary: 'Your squat volume is steady.',
    recommendations: [
      { title: 'Add a back-off set', detail: 'One set at 80 % after the top set.' },
    ],
    caution: null,
  },
  quota: { ...QUOTA, remaining: 3 },
  generatedAt: '2026-10-19T14:30:00.000Z',
};

const UPSTREAM_FAILED = {
  type: 'about:blank',
  title: 'Bad Gateway',
  status: 502,
  code: 'coach_upstream_failed',
};

/** An event stream whose events the test writes one by one. */
function eventStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    response: (): StreamResponse => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: null,
      stream: body,
    }),
    async send(event: string, data: unknown): Promise<void> {
      controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      await flush();
    },
    async close(): Promise<void> {
      controller?.close();
      await flush();
    },
    cancelled: () => cancelled,
  };
}

function plain(status: number, body: unknown): StreamResponse {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body,
    stream: null,
  };
}

type PostStream = ApiClient['postStream'];

function fakeApi(status: unknown = ENABLED) {
  const get = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve(status));
  const postStream = vi.fn<PostStream>();
  const api = { get, postStream } as unknown as Pick<ApiClient, 'get' | 'postStream'>;
  return { api, get, postStream };
}

async function ready(status: unknown = ENABLED) {
  const fake = fakeApi(status);
  const controller = new CoachController(fake.api);
  await controller.load();
  return { ...fake, controller };
}

function signalOf(postStream: ReturnType<typeof vi.fn<PostStream>>, call = 0): AbortSignal {
  const signal = postStream.mock.calls[call]?.[2]?.signal;
  if (signal === undefined) throw new Error('no signal');
  return signal;
}

describe('isCoachEnabled', () => {
  it('is true only when the flag is on, and false on failure', async () => {
    expect(await isCoachEnabled(fakeApi(ENABLED).api)).toBe(true);
    expect(await isCoachEnabled(fakeApi({ enabled: false }).api)).toBe(false);
    expect(await isCoachEnabled(fakeApi({ enabled: 'yes' }).api)).toBe(false);
    const failing = fakeApi();
    failing.get.mockRejectedValueOnce(new NetworkError('offline'));
    expect(await isCoachEnabled(failing.api)).toBe(false);
  });
});

describe('CoachController.load', () => {
  it('reads the status: ready with consent and quota, disabled, or an error', async () => {
    const { controller, get } = await ready();
    expect(get).toHaveBeenCalledWith(COACH_STATUS_PATH, expect.anything());
    expect(controller.get().status).toEqual({ kind: 'ready', consent: true, quota: QUOTA });

    expect((await ready({ enabled: false })).controller.get().status).toEqual({
      kind: 'disabled',
    });
    expect((await ready({ ...ENABLED, thirdPartyConsent: false })).controller.get().status).toEqual(
      { kind: 'ready', consent: false, quota: QUOTA },
    );

    const failing = fakeApi();
    failing.get.mockRejectedValueOnce(new AuthRequiredError());
    const offline = new CoachController(failing.api);
    await offline.load();
    expect(offline.get().status).toEqual({
      kind: 'error',
      error: { key: 'mobile.errors.sessionExpired', authRequired: true },
    });
  });
});

describe('CoachController.ask', () => {
  it('posts the trimmed question, shows partials, then the done answer and quota', async () => {
    const { controller, postStream } = await ready();
    const stream = eventStream();
    postStream.mockResolvedValueOnce(stream.response());

    const asked = controller.ask('  How do I progress?  ', 'en');
    await flush();
    expect(postStream).toHaveBeenCalledWith(
      COACH_ASK_PATH,
      { question: 'How do I progress?', locale: 'en' },
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    );
    expect(controller.get().ask).toEqual({ kind: 'pending', partial: null });

    await stream.send('partial', { summary: 'Your squat' });
    expect(controller.get().ask).toEqual({ kind: 'pending', partial: { summary: 'Your squat' } });

    await stream.send('done', ANSWER);
    await asked;
    expect(controller.get()).toEqual({
      status: { kind: 'ready', consent: true, quota: ANSWER.quota },
      ask: { kind: 'done', answer: ANSWER },
    });
    expect(stream.cancelled()).toBe(true);
  });

  it('discards the partials on an error event', async () => {
    const { controller, postStream } = await ready();
    const stream = eventStream();
    postStream.mockResolvedValueOnce(stream.response());

    const asked = controller.ask('Why?', 'fr');
    await stream.send('partial', { summary: 'Half' });
    await stream.send('error', UPSTREAM_FAILED);
    await asked;

    expect(controller.get().ask).toEqual({
      kind: 'error',
      error: { key: 'coach.errors.unavailable', authRequired: false },
    });
    expect(controller.get().status).toEqual({ kind: 'ready', consent: true, quota: QUOTA });
  });

  it('fails when the stream ends without an answer', async () => {
    const { controller, postStream } = await ready();
    const stream = eventStream();
    postStream.mockResolvedValueOnce(stream.response());

    const asked = controller.ask('Why?', 'fr');
    await stream.send('partial', { summary: 'Cut' });
    await stream.close();
    await asked;

    expect(controller.get().ask).toEqual({
      kind: 'error',
      error: { key: 'coach.errors.unavailable', authRequired: false },
    });
  });

  it('accepts a JSON answer from a server that does not stream', async () => {
    const { controller, postStream } = await ready();
    postStream.mockResolvedValueOnce(plain(200, ANSWER));
    await controller.ask('Why?', 'fr');
    expect(controller.get().ask).toEqual({ kind: 'done', answer: ANSWER });

    postStream.mockResolvedValueOnce(plain(200, { advice: {} }));
    await controller.ask('Why?', 'fr');
    expect(controller.get().ask).toMatchObject({ kind: 'error' });
  });

  it('maps the problem statuses returned before the stream opens', async () => {
    const quota = await ready();
    quota.postStream.mockResolvedValueOnce(
      plain(429, { title: 'Too Many Requests', status: 429, code: 'coach_quota_exceeded' }),
    );
    await quota.controller.ask('Why?', 'fr');
    expect(quota.controller.get()).toEqual({
      status: { kind: 'ready', consent: true, quota: { ...QUOTA, remaining: 0 } },
      ask: { kind: 'error', error: { key: 'coach.quotaExhausted', authRequired: false } },
    });

    const burst = await ready();
    burst.postStream.mockResolvedValueOnce(
      plain(429, { title: 'Too Many Requests', status: 429, code: 'coach_rate_limited' }),
    );
    await burst.controller.ask('Why?', 'fr');
    expect(burst.controller.get().ask).toEqual({
      kind: 'error',
      error: { key: 'coach.errors.rateLimited', authRequired: false },
    });

    const consent = await ready();
    consent.postStream.mockResolvedValueOnce(
      plain(403, { title: 'Forbidden', status: 403, code: 'third_party_consent_required' }),
    );
    await consent.controller.ask('Why?', 'fr');
    expect(consent.controller.get()).toEqual({
      status: { kind: 'ready', consent: false, quota: QUOTA },
      ask: { kind: 'idle' },
    });

    const disabled = await ready();
    disabled.postStream.mockResolvedValueOnce(
      plain(404, { title: 'Not Found', status: 404, code: 'coach_disabled' }),
    );
    await disabled.controller.ask('Why?', 'fr');
    expect(disabled.controller.get()).toEqual({
      status: { kind: 'disabled' },
      ask: { kind: 'idle' },
    });

    const outage = await ready();
    outage.postStream.mockResolvedValueOnce(
      plain(503, { title: 'Service Unavailable', status: 503, code: 'coach_not_configured' }),
    );
    await outage.controller.ask('Why?', 'fr');
    expect(outage.controller.get().ask).toEqual({
      kind: 'error',
      error: { key: 'coach.errors.unavailable', authRequired: false },
    });

    const offline = await ready();
    offline.postStream.mockRejectedValueOnce(new NetworkError('offline'));
    await offline.controller.ask('Why?', 'fr');
    expect(offline.controller.get().ask).toEqual({
      kind: 'error',
      error: { key: 'errors.network', authRequired: false },
    });
  });

  it('ignores a blank question and asks nothing without consent', async () => {
    const { controller, postStream } = await ready();
    await controller.ask('   ', 'fr');
    const noConsent = await ready({ ...ENABLED, thirdPartyConsent: false });
    await noConsent.controller.ask('Why?', 'fr');
    expect(postStream).not.toHaveBeenCalled();
    expect(noConsent.postStream).not.toHaveBeenCalled();
  });

  it('aborts the request in flight on cancel and leaves the state alone', async () => {
    const { controller, postStream } = await ready();
    const stream = eventStream();
    postStream.mockResolvedValueOnce(stream.response());

    const asked = controller.ask('Why?', 'fr');
    await stream.send('partial', { summary: 'Draft' });
    controller.cancel();
    expect(signalOf(postStream).aborted).toBe(true);

    await stream.send('done', ANSWER);
    await asked;
    expect(controller.get().ask).toEqual({ kind: 'pending', partial: { summary: 'Draft' } });
  });

  it('aborts the previous request when the member asks again', async () => {
    const { controller, postStream } = await ready();
    const first = eventStream();
    const second = eventStream();
    postStream.mockResolvedValueOnce(first.response()).mockResolvedValueOnce(second.response());

    const firstAsk = controller.ask('First?', 'fr');
    await first.send('partial', { summary: 'First draft' });
    const secondAsk = controller.ask('Second?', 'fr');
    await flush();
    expect(signalOf(postStream, 0).aborted).toBe(true);
    expect(controller.get().ask).toEqual({ kind: 'pending', partial: null });

    await first.send('partial', { summary: 'Late first draft' });
    expect(controller.get().ask).toEqual({ kind: 'pending', partial: null });

    await second.send('done', ANSWER);
    await secondAsk;
    expect(controller.get().ask).toEqual({ kind: 'done', answer: ANSWER });

    await first.send('done', ANSWER);
    await firstAsk;
    expect(controller.get().ask).toEqual({ kind: 'done', answer: ANSWER });
  });
});

describe('ApiClient.postStream', () => {
  function setup(responses: Response[]) {
    const fetchImpl = vi.fn((..._args: [string, RequestInit]) => {
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      return Promise.resolve(next);
    });
    const client = createApiClient({
      baseUrl: 'https://api.athlya.test',
      tokens: { getAccessToken: () => 'access-1' },
      refreshAccessToken: () => Promise.resolve('access-2'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return { client, fetchImpl };
  }

  it('asks for an event stream and hands back the unread body', async () => {
    const { client, fetchImpl } = setup([
      new Response('event: done\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ]);

    const response = await client.postStream(COACH_ASK_PATH, { question: 'q', locale: 'fr' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.athlya.test/v1/coach/ask');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer access-1',
      'Content-Type': 'application/json',
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.stream).not.toBeNull();
    const text = await new Response(response.stream as ReadableStream<Uint8Array>).text();
    expect(text).toBe('event: done\ndata: {}\n\n');
  });

  it('parses a problem or JSON answer, and refreshes the session on 401', async () => {
    const { client, fetchImpl } = setup([
      new Response(JSON.stringify({ title: 'Unauthorized', status: 401 }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }),
      new Response(JSON.stringify({ title: 'Forbidden', status: 403 }), {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      }),
    ]);

    const response = await client.postStream(COACH_ASK_PATH, { question: 'q', locale: 'fr' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, retry] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(retry.headers).toMatchObject({ Authorization: 'Bearer access-2' });
    expect(response).toMatchObject({
      status: 403,
      body: { title: 'Forbidden', status: 403 },
      stream: null,
    });
  });
});
