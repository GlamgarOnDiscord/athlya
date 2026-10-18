/**
 * Unit tests for the AI coach use case (task 21.1). The language model is
 * the AI SDK mock: no test reaches the network.
 */

import { CoachAskResponseSchema } from '@athlya/shared/schemas/api';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi, type Mock } from 'vitest';

import { CoachError } from '../src/errors.js';
import {
  COACH_SESSION_READ_LIMIT,
  DEFAULT_COACH_DAILY_LIMIT,
  askCoach,
  getCoachQuota,
  type AskCoachDeps,
  type CoachQuotaStore,
} from '../src/service.js';

import { NOW, USER_ID, VALID_ADVICE, session } from './fixtures.js';

import type { ProgressionRepo } from '@athlya/members/progression';

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function textResult(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  };
}

interface MemoryQuota {
  readonly counts: Map<string, number>;
  readonly increment: Mock<CoachQuotaStore['increment']>;
  readonly peek: Mock<CoachQuotaStore['peek']>;
}

function memoryQuota(initial = 0): MemoryQuota {
  const counts = new Map<string, number>();
  return {
    counts,
    increment: vi.fn((userId: string, day: string) => {
      const key = `${userId}:${day}`;
      const next = (counts.get(key) ?? initial) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    }),
    peek: vi.fn((userId: string, day: string) =>
      Promise.resolve(counts.get(`${userId}:${day}`) ?? initial),
    ),
  };
}

const ROWS = [
  session(
    '2026-10-14T18:00:00.000Z',
    [{ name: 'Back squat', sets: [{ reps: 5, weightKg: 100 }] }],
    { notes: 'private note' },
  ),
];

type TestDeps = Omit<AskCoachDeps, 'model' | 'sessions' | 'quota'> & {
  readonly model: MockLanguageModelV4;
  readonly sessions: { readonly listInWindow: Mock<ProgressionRepo['listInWindow']> };
  readonly quota: MemoryQuota;
};

function buildDeps(overrides: Partial<AskCoachDeps> = {}): TestDeps {
  const model = new MockLanguageModelV4({
    doGenerate: textResult(JSON.stringify(VALID_ADVICE)),
  });
  const sessions = {
    listInWindow: vi.fn<ProgressionRepo['listInWindow']>(() => Promise.resolve(ROWS)),
  };
  return {
    model,
    sessions,
    consents: { hasThirdPartyConsent: () => Promise.resolve(true) },
    quota: memoryQuota(),
    now: () => NOW,
    ...overrides,
  } as TestDeps;
}

const REQUEST = { question: 'How do I add weight to my squat?', locale: 'en' as const };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CoachError) return err.code;
    throw err;
  }
  throw new Error('expected a CoachError');
}

describe('askCoach', () => {
  it('returns validated advice with the remaining quota', async () => {
    const deps = buildDeps();
    const result = await askCoach(USER_ID, REQUEST, deps);

    expect(CoachAskResponseSchema.parse(result)).toEqual(result);
    expect(result.advice).toEqual(VALID_ADVICE);
    expect(result.quota).toEqual({
      limit: DEFAULT_COACH_DAILY_LIMIT,
      remaining: DEFAULT_COACH_DAILY_LIMIT - 1,
      resetsAt: '2026-10-16T00:00:00.000Z',
    });
    expect(result.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it('reads 30 days of the caller sessions once, with a row cap', async () => {
    const deps = buildDeps();
    await askCoach(USER_ID, REQUEST, deps);
    expect(deps.sessions.listInWindow).toHaveBeenCalledTimes(1);
    expect(deps.sessions.listInWindow).toHaveBeenCalledWith(USER_ID, {
      from: new Date('2026-09-16T00:00:00.000Z'),
      to: new Date('2026-10-16T00:00:00.000Z'),
      limit: COACH_SESSION_READ_LIMIT + 1,
    });
  });

  it('sends a minimised prompt: no ids, no notes', async () => {
    const deps = buildDeps();
    await askCoach(USER_ID, REQUEST, deps);
    const call = deps.model.doGenerateCalls[0];
    const sent = JSON.stringify(call?.prompt);
    expect(sent).toContain('Back squat');
    expect(sent).toContain(REQUEST.question);
    expect(sent).not.toContain(USER_ID);
    expect(sent).not.toContain(ROWS[0]?.id ?? 'missing');
    expect(sent).not.toContain('private note');
    expect(call?.responseFormat?.type).toBe('json');
  });

  it('refuses without third-party consent, before reading data or quota', async () => {
    const deps = buildDeps({ consents: { hasThirdPartyConsent: () => Promise.resolve(false) } });
    expect(await codeOf(askCoach(USER_ID, REQUEST, deps))).toBe('consent_required');
    expect(deps.sessions.listInWindow).not.toHaveBeenCalled();
    expect(deps.quota.increment).not.toHaveBeenCalled();
    expect(deps.model.doGenerateCalls).toHaveLength(0);
  });

  it('refuses past the daily quota with a Retry-After until UTC midnight', async () => {
    const deps = buildDeps({ quota: memoryQuota(DEFAULT_COACH_DAILY_LIMIT) });
    const error = await askCoach(USER_ID, REQUEST, deps).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CoachError);
    expect((error as CoachError).code).toBe('quota_exceeded');
    // 14:30 UTC → 9 h 30 min to midnight.
    expect((error as CoachError).retryAfterSec).toBe(9.5 * 3600);
    expect(deps.model.doGenerateCalls).toHaveLength(0);
  });

  it('honours a custom daily limit', async () => {
    const deps = buildDeps({ dailyLimit: 2 });
    await askCoach(USER_ID, REQUEST, deps);
    await askCoach(USER_ID, REQUEST, deps);
    expect(await codeOf(askCoach(USER_ID, REQUEST, deps))).toBe('quota_exceeded');
  });

  it('fails closed when the quota store is down', async () => {
    const quota: CoachQuotaStore = {
      increment: () => Promise.reject(new Error('ECONNRESET')),
      peek: () => Promise.reject(new Error('ECONNRESET')),
    };
    const deps = buildDeps({ quota });
    expect(await codeOf(askCoach(USER_ID, REQUEST, deps))).toBe('quota_unavailable');
    expect(deps.model.doGenerateCalls).toHaveLength(0);
  });

  it('maps a provider failure to upstream_failed', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error('socket hang up')),
    });
    expect(await codeOf(askCoach(USER_ID, REQUEST, buildDeps({ model })))).toBe('upstream_failed');
  });

  it('maps output that is not JSON or breaks the schema to invalid_output', async () => {
    for (const text of [
      'not json',
      JSON.stringify({ summary: 'x', recommendations: [], caution: null }),
      JSON.stringify({ ...VALID_ADVICE, extra: true }),
    ]) {
      const model = new MockLanguageModelV4({ doGenerate: textResult(text) });
      expect(await codeOf(askCoach(USER_ID, REQUEST, buildDeps({ model })))).toBe('invalid_output');
    }
  });
});

describe('getCoachQuota', () => {
  it('reports the remaining quota without consuming it', async () => {
    const quota = memoryQuota(3);
    const view = await getCoachQuota(USER_ID, { quota, now: () => NOW, dailyLimit: 5 });
    expect(view).toEqual({ limit: 5, remaining: 2, resetsAt: '2026-10-16T00:00:00.000Z' });
    expect(quota.increment).not.toHaveBeenCalled();
  });

  it('never reports a negative remaining count', async () => {
    const view = await getCoachQuota(USER_ID, { quota: memoryQuota(50), now: () => NOW });
    expect(view.remaining).toBe(0);
  });

  it('fails closed when the quota store is down', async () => {
    const quota: CoachQuotaStore = {
      increment: () => Promise.reject(new Error('down')),
      peek: () => Promise.reject(new Error('down')),
    };
    expect(await codeOf(getCoachQuota(USER_ID, { quota, now: () => NOW }))).toBe(
      'quota_unavailable',
    );
  });
});
