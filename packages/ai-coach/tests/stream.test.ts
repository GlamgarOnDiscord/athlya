/**
 * Streamed coach answer (task 21.2): `streamCoach` and the partial
 * snapshot clipper. The language model is the AI SDK mock streaming
 * scripted chunks: no test reaches the network.
 */

import {
  CoachAdvicePartialSchema,
  CoachAskResponseSchema,
  type CoachAdvicePartial,
  type CoachAskResponse,
} from '@athlya/shared/schemas/api';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { CoachError } from '../src/errors.js';
import { COACH_PARTIAL_LIMITS, toCoachAdvicePartial } from '../src/partial.js';
import {
  DEFAULT_COACH_DAILY_LIMIT,
  streamCoach,
  type AskCoachDeps,
  type CoachAnswerStream,
  type CoachQuotaStore,
} from '../src/service.js';

import { NOW, USER_ID, VALID_ADVICE } from './fixtures.js';

import type { ProgressionRepo } from '@athlya/members/progression';

type StreamPart = Parameters<
  ReadableStreamDefaultController<
    Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
      ? P
      : never
  >['enqueue']
>[0];

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

/** Stream `text` to the SDK in `pieces` text deltas. */
function textStream(text: string, pieces = 6): StreamPart[] {
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const deltas: StreamPart[] = [];
  for (let i = 0; i < text.length; i += size) {
    deltas.push({ type: 'text-delta', id: 't', delta: text.slice(i, i + size) });
  }
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...deltas,
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
  ];
}

function streamingModel(chunks: StreamPart[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: () => Promise.resolve({ stream: simulateReadableStream({ chunks }) }),
  });
}

function memoryQuota(initial = 0): CoachQuotaStore {
  let count = initial;
  return {
    increment: () => Promise.resolve((count += 1)),
    peek: () => Promise.resolve(count),
  };
}

function buildDeps(overrides: Partial<AskCoachDeps> = {}): AskCoachDeps {
  const sessions: ProgressionRepo = { listInWindow: () => Promise.resolve([]) };
  return {
    model: streamingModel(textStream(JSON.stringify(VALID_ADVICE))),
    sessions,
    consents: { hasThirdPartyConsent: () => Promise.resolve(true) },
    quota: memoryQuota(),
    now: () => NOW,
    ...overrides,
  };
}

const REQUEST = { question: 'How do I add weight to my squat?', locale: 'en' as const };

interface Drained {
  readonly partials: CoachAdvicePartial[];
  readonly result?: CoachAskResponse;
  readonly error?: unknown;
}

async function drain(stream: CoachAnswerStream): Promise<Drained> {
  const partials: CoachAdvicePartial[] = [];
  try {
    for (;;) {
      const step = await stream.next();
      if (step.done === true) return { partials, result: step.value };
      partials.push(step.value);
    }
  } catch (error) {
    return { partials, error };
  }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CoachError) return err.code;
    throw err;
  }
  throw new Error('expected a CoachError');
}

describe('streamCoach', () => {
  it('yields growing snapshots, then the validated response', async () => {
    const deps = buildDeps();
    const { partials, result, error } = await drain(await streamCoach(USER_ID, REQUEST, deps));

    expect(error).toBeUndefined();
    expect(partials.length).toBeGreaterThan(1);
    for (const partial of partials) {
      expect(CoachAdvicePartialSchema.parse(partial)).toEqual(partial);
    }
    expect(new Set(partials.map((p) => JSON.stringify(p))).size).toBe(partials.length);
    expect(partials.at(-1)).toEqual(VALID_ADVICE);
    expect(result).toBeDefined();
    expect(CoachAskResponseSchema.parse(result)).toEqual(result);
    expect(result?.advice).toEqual(VALID_ADVICE);
    expect(result?.quota.remaining).toBe(DEFAULT_COACH_DAILY_LIMIT - 1);
    expect(result?.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it('refuses before the stream starts: consent, quota, quota store', async () => {
    const noConsent = buildDeps({
      consents: { hasThirdPartyConsent: () => Promise.resolve(false) },
    });
    expect(await refusal(streamCoach(USER_ID, REQUEST, noConsent))).toBe('consent_required');
    expect((noConsent.model as MockLanguageModelV4).doStreamCalls).toHaveLength(0);

    const spent = buildDeps({ quota: memoryQuota(DEFAULT_COACH_DAILY_LIMIT) });
    expect(await refusal(streamCoach(USER_ID, REQUEST, spent))).toBe('quota_exceeded');

    const down = buildDeps({
      quota: { increment: () => Promise.reject(new Error('down')), peek: () => Promise.resolve(0) },
    });
    expect(await refusal(streamCoach(USER_ID, REQUEST, down))).toBe('quota_unavailable');
  });

  it('consumes the quota before the model call', async () => {
    const quota = memoryQuota();
    const increment = vi.spyOn(quota, 'increment');
    const model = streamingModel(textStream(JSON.stringify(VALID_ADVICE)));
    await streamCoach(USER_ID, REQUEST, buildDeps({ quota, model }));
    expect(increment).toHaveBeenCalledTimes(1);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('maps a provider error mid-stream to upstream_failed', async () => {
    const chunks = textStream(JSON.stringify(VALID_ADVICE)).slice(0, 4);
    chunks.push({ type: 'error', error: new Error('socket hang up sk-secret') });
    const deps = buildDeps({ model: streamingModel(chunks) });
    const { result, error } = await drain(await streamCoach(USER_ID, REQUEST, deps));
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(CoachError);
    expect((error as CoachError).code).toBe('upstream_failed');
  });

  it('maps a provider that fails to start to upstream_failed', async () => {
    const model = new MockLanguageModelV4({
      doStream: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const { error } = await drain(await streamCoach(USER_ID, REQUEST, buildDeps({ model })));
    expect((error as CoachError).code).toBe('upstream_failed');
  });

  it('maps output that breaks the schema to invalid_output, after bounded partials', async () => {
    for (const text of [
      'not json',
      JSON.stringify({ ...VALID_ADVICE, recommendations: [] }),
      JSON.stringify({ ...VALID_ADVICE, extra: 'x'.repeat(2000) }),
      JSON.stringify({ ...VALID_ADVICE, summary: 's'.repeat(5000) }),
    ]) {
      const deps = buildDeps({ model: streamingModel(textStream(text)) });
      const { partials, result, error } = await drain(await streamCoach(USER_ID, REQUEST, deps));
      expect(result).toBeUndefined();
      expect((error as CoachError).code).toBe('invalid_output');
      for (const partial of partials) {
        expect(CoachAdvicePartialSchema.safeParse(partial).success).toBe(true);
      }
    }
  });

  it('aborts the provider call when the caller signal fires', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const model = new MockLanguageModelV4({
      doStream: (options) => {
        seen = options.abortSignal;
        return Promise.resolve({
          stream: simulateReadableStream({ chunks: textStream(JSON.stringify(VALID_ADVICE)) }),
        });
      },
    });
    const stream = await streamCoach(USER_ID, REQUEST, buildDeps({ model }), controller.signal);
    await stream.next();
    controller.abort();
    expect(seen?.aborted).toBe(true);
    await stream.return(undefined as never);
  });
});

describe('toCoachAdvicePartial', () => {
  it('keeps only the advice fields, as clipped strings', () => {
    expect(
      toCoachAdvicePartial({
        summary: 'a'.repeat(1000),
        recommendations: [{ title: 't'.repeat(200), detail: 3, extra: 'x' }, 'junk', null],
        caution: 'c'.repeat(1000),
        userId: USER_ID,
      }),
    ).toEqual({
      summary: 'a'.repeat(COACH_PARTIAL_LIMITS.summary),
      recommendations: [{ title: 't'.repeat(COACH_PARTIAL_LIMITS.title) }, {}, {}],
      caution: 'c'.repeat(COACH_PARTIAL_LIMITS.caution),
    });
  });

  it('keeps a null caution and drops non-object input', () => {
    expect(toCoachAdvicePartial({ caution: null })).toEqual({ caution: null });
    for (const raw of [undefined, null, 'text', 42, ['summary']]) {
      expect(toCoachAdvicePartial(raw)).toEqual({});
    }
  });

  it('always yields a snapshot that matches CoachAdvicePartialSchema', () => {
    fc.assert(
      fc.property(fc.anything({ withObjectString: true }), fc.anything(), (a, b) => {
        for (const raw of [
          a,
          { summary: a, recommendations: b, caution: a },
          { recommendations: [a, b, { title: a, detail: b }] },
        ]) {
          expect(CoachAdvicePartialSchema.safeParse(toCoachAdvicePartial(raw)).success).toBe(true);
        }
      }),
    );
  });

  it('caps the recommendations at five', () => {
    const many = Array.from({ length: 9 }, () => ({ title: 'x', detail: 'y' }));
    expect(toCoachAdvicePartial({ recommendations: many }).recommendations).toHaveLength(5);
  });
});
