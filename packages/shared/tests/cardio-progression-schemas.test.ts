import { describe, expect, it } from 'vitest';

import {
  CARDIO_PROGRESSION_MACHINES,
  CardioProgressionQuerySchema,
  CardioProgressionResponseSchema,
  ProgressionResponseSchema,
} from '../src/schemas/api.js';

const EMPTY = {
  windowDays: 90,
  from: '2026-07-18T00:00:00.000Z',
  to: '2026-10-16T00:00:00.000Z',
  bucket: 'week',
  totals: { sessions: 0, durationSec: 0, distanceM: 0, energyKcal: 0 },
  machines: [],
  truncated: false,
  skippedSessions: 0,
} as const;

describe('CardioProgressionQuerySchema', () => {
  it('defaults to a 90-day weekly series', () => {
    expect(CardioProgressionQuerySchema.parse({})).toEqual({ window: '90', bucket: 'week' });
  });

  it('accepts the day bucket and rejects other buckets, windows and keys', () => {
    expect(CardioProgressionQuerySchema.parse({ window: '365', bucket: 'day' })).toEqual({
      window: '365',
      bucket: 'day',
    });
    expect(CardioProgressionQuerySchema.safeParse({ bucket: 'month' }).success).toBe(false);
    expect(CardioProgressionQuerySchema.safeParse({ window: '7' }).success).toBe(false);
    expect(CardioProgressionQuerySchema.safeParse({ userId: 'x' }).success).toBe(false);
  });
});

describe('CardioProgressionResponseSchema', () => {
  it('accepts an empty response and rejects unknown keys', () => {
    expect(CardioProgressionResponseSchema.parse(EMPTY)).toEqual(EMPTY);
    expect(CardioProgressionResponseSchema.safeParse({ ...EMPTY, extra: 1 }).success).toBe(false);
  });

  it('keys machines by the FTMS families plus unspecified', () => {
    expect(CARDIO_PROGRESSION_MACHINES).toEqual([
      'indoorBike',
      'treadmill',
      'rower',
      'crossTrainer',
      'unspecified',
    ]);
  });

  it('is a separate contract: the strict strength response refuses it', () => {
    expect(ProgressionResponseSchema.safeParse(EMPTY).success).toBe(false);
  });
});
