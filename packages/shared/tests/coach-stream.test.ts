/**
 * Streamed AI coach answer, client side (task 21.2).
 */

import { describe, expect, it } from 'vitest';

import { isEventStream, readCoachStream } from '../src/coach-stream.js';

import type { CoachAdvicePartial, CoachAskResponse } from '../src/schemas/api.js';
import type { ByteStream } from '../src/sse.js';

const ANSWER: CoachAskResponse = {
  advice: {
    summary: 'Steady squat volume.',
    recommendations: [{ title: 'Deload', detail: 'Cut volume by 40 % next week.' }],
    caution: null,
  },
  quota: { limit: 10, remaining: 3, resetsAt: '2026-10-16T00:00:00.000Z' },
  generatedAt: '2026-10-15T14:30:00.000Z',
};

const UPSTREAM_FAILED = {
  type: 'about:blank',
  title: 'Bad Gateway',
  status: 502,
  detail: 'The AI coach provider did not answer',
  code: 'coach_upstream_failed',
  traceId: 'trace-0000',
};

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function streamOf(text: string): ByteStream {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    getReader: () => ({
      read: () => {
        if (sent) return Promise.resolve({ done: true, value: undefined });
        sent = true;
        return Promise.resolve({ done: false, value: bytes });
      },
      cancel: () => Promise.resolve(),
      releaseLock: () => undefined,
    }),
  };
}

async function read(text: string) {
  const partials: CoachAdvicePartial[] = [];
  const result = await readCoachStream(streamOf(text), (partial) => {
    partials.push(partial);
  });
  return { partials, result };
}

describe('isEventStream', () => {
  it('matches the media type, ignoring parameters and case', () => {
    expect(isEventStream('text/event-stream')).toBe(true);
    expect(isEventStream('Text/Event-Stream; charset=utf-8')).toBe(true);
    expect(isEventStream('application/json')).toBe(false);
    expect(isEventStream(null)).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
  });
});

describe('readCoachStream', () => {
  it('reports the partial snapshots, then the validated answer', async () => {
    const { partials, result } = await read(
      sse('partial', { summary: 'Steady' }) +
        sse('partial', { summary: 'Steady squat', recommendations: [{ title: 'De' }] }) +
        sse('done', ANSWER),
    );
    expect(partials).toEqual([
      { summary: 'Steady' },
      { summary: 'Steady squat', recommendations: [{ title: 'De' }] },
    ]);
    expect(result).toEqual({ kind: 'done', answer: ANSWER });
  });

  it('returns the problem of an error event', async () => {
    const { partials, result } = await read(
      sse('partial', { summary: 'Half' }) + sse('error', UPSTREAM_FAILED),
    );
    expect(partials).toHaveLength(1);
    expect(result).toEqual({ kind: 'error', problem: UPSTREAM_FAILED });
  });

  it('skips invalid partials and unknown events', async () => {
    const { partials, result } = await read(
      sse('partial', 'not json') +
        sse('partial', { summary: 'x', extra: true }) +
        sse('ping', {}) +
        sse('done', ANSWER),
    );
    expect(partials).toEqual([]);
    expect(result.kind).toBe('done');
  });

  it('fails without a problem on an invalid answer, an invalid problem or no terminal event', async () => {
    expect((await read(sse('done', { advice: {} }))).result).toEqual({
      kind: 'error',
      problem: undefined,
    });
    expect((await read(sse('error', 'oops'))).result).toEqual({
      kind: 'error',
      problem: undefined,
    });
    expect((await read(sse('partial', { summary: 'cut' }))).result).toEqual({
      kind: 'error',
      problem: undefined,
    });
  });

  it('rejects when the body read fails', async () => {
    const failing: ByteStream = {
      getReader: () => ({
        read: () => Promise.reject(new Error('aborted')),
        cancel: () => Promise.resolve(),
        releaseLock: () => undefined,
      }),
    };
    await expect(readCoachStream(failing, () => undefined)).rejects.toThrow('aborted');
  });
});
