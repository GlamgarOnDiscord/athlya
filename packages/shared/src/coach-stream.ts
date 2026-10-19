/**
 * Client side of the streamed `POST /v1/coach/ask` (task 21.2), shared by
 * the web and mobile coach screens.
 *
 * The request sends `Accept: text/event-stream`. Refusals before the
 * stream opens (consent, quota, flag, limiter) keep their
 * `application/problem+json` status; once the stream is open the server
 * sends `partial` snapshots, then one terminal `done` or `error` event
 * (see {@link COACH_STREAM_EVENTS}).
 */

import {
  CoachAdvicePartialSchema,
  CoachAskResponseSchema,
  type CoachAdvicePartial,
  type CoachAskResponse,
} from './schemas/api.js';
import { ProblemDetailsSchema, type ProblemDetails } from './schemas/problem.js';
import { readServerSentEvents, type ByteStream } from './sse.js';

/** `Accept` value that asks `POST /v1/coach/ask` to stream its answer. */
export const COACH_STREAM_ACCEPT = 'text/event-stream';

/** True when a response `Content-Type` is an event stream. */
export function isEventStream(contentType: string | null | undefined): boolean {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === COACH_STREAM_ACCEPT;
}

/**
 * Terminal outcome of a coach stream. `error` carries the problem of an
 * `error` event; it is `undefined` when the stream ended without a terminal
 * event or sent an answer that does not match {@link CoachAskResponseSchema}.
 */
export type CoachStreamResult =
  | { readonly kind: 'done'; readonly answer: CoachAskResponse }
  | { readonly kind: 'error'; readonly problem: ProblemDetails | undefined };

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads a coach event stream to its terminal event. Valid `partial`
 * snapshots go to `onPartial` (invalid ones are skipped); the caller drops
 * them unless the result is `done`. Read failures, an aborted request
 * included, reject.
 */
export async function readCoachStream(
  body: ByteStream,
  onPartial: (advice: CoachAdvicePartial) => void,
): Promise<CoachStreamResult> {
  for await (const message of readServerSentEvents(body)) {
    const { event } = message;
    if (event === 'partial') {
      const partial = CoachAdvicePartialSchema.safeParse(parseJson(message.data));
      if (partial.success) onPartial(partial.data);
    } else if (event === 'done') {
      const answer = CoachAskResponseSchema.safeParse(parseJson(message.data));
      return answer.success
        ? { kind: 'done', answer: answer.data }
        : { kind: 'error', problem: undefined };
    } else if (event === 'error') {
      const problem = ProblemDetailsSchema.safeParse(parseJson(message.data));
      return { kind: 'error', problem: problem.success ? problem.data : undefined };
    }
  }
  return { kind: 'error', problem: undefined };
}
