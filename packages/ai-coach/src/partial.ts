/**
 * Partial advice snapshots of the streamed coach answer (task 21.2).
 *
 * The AI SDK parses the model's JSON as it arrives and yields whatever
 * object it holds so far. That object is not validated: any key, any
 * type, any length. {@link toCoachAdvicePartial} keeps only the fields
 * of `CoachAdviceSchema`, as strings, clipped to the same bounds, so a
 * snapshot never carries more than the final advice could.
 */

import type { CoachAdvicePartial } from '@athlya/shared/schemas/api';

/** Bounds of `CoachAdviceSchema`, mirrored by `CoachAdvicePartialSchema`. */
export const COACH_PARTIAL_LIMITS = {
  summary: 600,
  recommendations: 5,
  title: 80,
  detail: 400,
  caution: 300,
} as const;

type Recommendation = NonNullable<CoachAdvicePartial['recommendations']>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function recommendationOf(value: unknown): Recommendation {
  const out: Recommendation = {};
  if (!isRecord(value)) return out;
  const title = clip(value['title'], COACH_PARTIAL_LIMITS.title);
  const detail = clip(value['detail'], COACH_PARTIAL_LIMITS.detail);
  if (title !== undefined) out.title = title;
  if (detail !== undefined) out.detail = detail;
  return out;
}

/** Bounded snapshot of a partially parsed model output. */
export function toCoachAdvicePartial(raw: unknown): CoachAdvicePartial {
  const out: CoachAdvicePartial = {};
  if (!isRecord(raw)) return out;

  const summary = clip(raw['summary'], COACH_PARTIAL_LIMITS.summary);
  if (summary !== undefined) out.summary = summary;

  const recommendations = raw['recommendations'];
  if (Array.isArray(recommendations)) {
    out.recommendations = recommendations
      .slice(0, COACH_PARTIAL_LIMITS.recommendations)
      .map(recommendationOf);
  }

  const caution = raw['caution'];
  if (caution === null) {
    out.caution = null;
  } else {
    const clipped = clip(caution, COACH_PARTIAL_LIMITS.caution);
    if (clipped !== undefined) out.caution = clipped;
  }
  return out;
}
