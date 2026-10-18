/**
 * Shared fixtures for the `@athlya/ai-coach` tests.
 */

export const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
export const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-0000000000aa';
/** Thursday 2026-10-15, 14:30 UTC. */
export const NOW = Date.parse('2026-10-15T14:30:00.000Z');

let counter = 0;
function nextId(): string {
  counter += 1;
  return `018f3c11-4e2d-7b53-9a0c-${counter.toString(16).padStart(12, '0')}`;
}

export interface SetInput {
  reps: number;
  weightKg?: number;
}

export interface SessionOptions {
  readonly notes?: string | null;
  readonly durationMin?: number | null;
}

export function session(
  startedAt: string,
  exercises: Array<{ name: string; sets: SetInput[] }>,
  options: SessionOptions = {},
) {
  return {
    id: nextId(),
    userId: USER_ID,
    studioId: STUDIO_ID,
    startedAt,
    durationMin: options.durationMin === undefined ? 60 : options.durationMin,
    exercises,
    notes: options.notes ?? null,
    createdAt: startedAt,
  };
}

export const VALID_ADVICE = {
  summary: 'Three sessions a week with steady squat volume.',
  recommendations: [
    { title: 'Add a deload week', detail: 'Cut the volume by 40 % next week to recover.' },
  ],
  caution: null,
};
