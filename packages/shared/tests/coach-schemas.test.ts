/**
 * AI coach schemas (Epic 21): request, model output and responses.
 */

import { describe, expect, it } from 'vitest';

import {
  COACH_QUESTION_MAX_LENGTH,
  CoachAdviceSchema,
  CoachAskRequestSchema,
  CoachAskResponseSchema,
  CoachStatusResponseSchema,
} from '../src/schemas/api.js';

const ADVICE = {
  summary: 'Steady squat volume.',
  recommendations: [{ title: 'Deload', detail: 'Cut volume by 40 % next week.' }],
  caution: null,
};

const QUOTA = { limit: 10, remaining: 3, resetsAt: '2026-10-16T00:00:00.000Z' };

describe('CoachAskRequestSchema', () => {
  it('trims the question and defaults the locale to fr', () => {
    expect(CoachAskRequestSchema.parse({ question: '  How?  ' })).toEqual({
      question: 'How?',
      locale: 'fr',
    });
  });

  it.each([
    { question: '' },
    { question: '   ' },
    { question: 'x'.repeat(COACH_QUESTION_MAX_LENGTH + 1) },
    { question: 'ok', locale: 'de' },
    { question: 'ok', context: 'injected' },
  ])('rejects %j', (body) => {
    expect(CoachAskRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('CoachAdviceSchema', () => {
  it('accepts a well-formed advice', () => {
    expect(CoachAdviceSchema.parse(ADVICE)).toEqual(ADVICE);
  });

  it.each([
    { ...ADVICE, recommendations: [] },
    { ...ADVICE, recommendations: Array.from({ length: 6 }, () => ADVICE.recommendations[0]) },
    { ...ADVICE, summary: 'x'.repeat(601) },
    { ...ADVICE, caution: undefined },
    { ...ADVICE, extra: 'field' },
    { ...ADVICE, recommendations: [{ title: 'x'.repeat(81), detail: 'ok' }] },
  ])('rejects model output that breaks the contract (%#)', (output) => {
    expect(CoachAdviceSchema.safeParse(output).success).toBe(false);
  });
});

describe('CoachStatusResponseSchema', () => {
  it('accepts the disabled and enabled shapes only', () => {
    expect(CoachStatusResponseSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(
      CoachStatusResponseSchema.safeParse({ enabled: true, thirdPartyConsent: false, quota: QUOTA })
        .success,
    ).toBe(true);
    expect(CoachStatusResponseSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(
      CoachStatusResponseSchema.safeParse({ enabled: false, thirdPartyConsent: true }).success,
    ).toBe(false);
  });
});

describe('CoachAskResponseSchema', () => {
  it('round-trips through JSON', () => {
    const body = { advice: ADVICE, quota: QUOTA, generatedAt: '2026-10-15T14:30:00.000Z' };
    expect(CoachAskResponseSchema.parse(JSON.parse(JSON.stringify(body)))).toEqual(body);
  });
});
