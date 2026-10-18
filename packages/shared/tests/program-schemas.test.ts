import { describe, expect, it } from 'vitest';

import {
  CreateProgramRequestSchema,
  MAX_PROGRAM_EXERCISES,
  MAX_PROGRAM_SCHEDULE_BYTES,
  MAX_PROGRAM_WEEKS,
  UpdateProgramRequestSchema,
} from '../src/schemas/api.js';

/** Gateway body cap on `/v1/*` (base-app.ts `bodyLimit`). */
const GATEWAY_BODY_LIMIT = 256 * 1024;

function program(
  exerciseName: string,
  notes: string,
  size = { weeks: MAX_PROGRAM_WEEKS, days: 7, exercises: MAX_PROGRAM_EXERCISES },
) {
  return {
    title: 'x'.repeat(120),
    description: 'é'.repeat(2000),
    status: 'published' as const,
    weeks: Array.from({ length: size.weeks }, (_, w) => ({
      weekNumber: w + 1,
      title: 'w'.repeat(120),
      workouts: Array.from({ length: size.days }, (_, d) => ({
        dayNumber: d + 1,
        title: 't'.repeat(120),
        exercises: Array.from({ length: size.exercises }, () => ({
          name: exerciseName,
          sets: 20,
          reps: 200,
          durationSec: 3600,
          weightKg: 999.5,
          restSec: 900,
          notes,
        })),
      })),
    })),
  };
}

describe('program request size', () => {
  it('rejects a schedule at the per-field maxima, which would not fit the gateway', () => {
    // Every field is within its own bound ('é' is one UTF-16 unit, two bytes).
    const body = program('é'.repeat(120), 'é'.repeat(280));
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeGreaterThan(
      GATEWAY_BODY_LIMIT,
    );
    const parsed = CreateProgramRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toEqual(['weeks']);
    expect(parsed.error?.issues[0]?.message).toMatch(/KiB/u);
    expect(UpdateProgramRequestSchema.safeParse({ version: 0, weeks: body.weeks }).success).toBe(
      false,
    );
  });

  it('keeps every accepted request under the gateway cap', () => {
    // The schedule cap plus the largest title / description / status.
    const otherFields = new TextEncoder().encode(
      JSON.stringify({
        title: '🏋'.repeat(120),
        description: '🏋'.repeat(2000),
        status: 'published',
      }),
    ).length;
    expect(MAX_PROGRAM_SCHEDULE_BYTES + otherFields + 64).toBeLessThan(GATEWAY_BODY_LIMIT);
  });

  it('accepts a large realistic program (12 weeks, 6 days, 10 exercises)', () => {
    const body = program('Back squat', 'Keep the bar path vertical', {
      weeks: 12,
      days: 6,
      exercises: 10,
    });
    expect(CreateProgramRequestSchema.safeParse(body).success).toBe(true);
  });
});
