/**
 * Consumer for `auth.password_reset.requested` (issues #645, #650).
 *
 * The event is recorded by `auth_request_password_reset` (migration
 * 0043) when a reset is requested for a live account, drained from the
 * outbox onto the notifications lane, and handled here:
 *
 *   1. `begin` marks the event in flight for a short TTL. Another
 *      delivery of the same event meanwhile is retried later (not
 *      acked); one arriving after the TTL — e.g. after an isolate crash
 *      mid-send — takes over. A completed event is acked as a duplicate.
 *   2. `deliverResetEmail` derives the request's token, stores its hash
 *      and sends the link with an idempotency key, so an attempt whose
 *      outcome was ambiguous can be retried without invalidating a link
 *      already delivered.
 *   3. Success marks the event completed (24 h). Failure clears the
 *      in-flight mark and rethrows: the dispatcher retries the message
 *      (`max_retries = 5`), then the queue moves it to the DLQ.
 *
 * Logs carry the event id and the outcome only: never the link, the
 * token or the recipient address.
 */

import { deliverResetEmail } from '@athlya/auth';

import type { DeliverResetDeps, DeliverResetResult } from '@athlya/auth';
import type { AuthPasswordResetRequestedEvent } from '@athlya/shared/events';

/** In-flight mark TTL; also the delay before an in-flight duplicate is retried. */
export const PASSWORD_RESET_IN_FLIGHT_TTL_SECONDS = 120;

/** How long a completed delivery is remembered (redelivery window). */
export const PASSWORD_RESET_COMPLETED_TTL_SECONDS = 24 * 60 * 60;

export type DeliveryBegin = 'acquired' | 'in_flight' | 'completed';

/**
 * Per-event delivery state. Implementations must make `begin` atomic
 * (`SET NX` on Upstash Redis).
 */
export interface PasswordResetDeliveryStore {
  begin(eventId: string, inFlightTtlSec: number): Promise<DeliveryBegin>;
  complete(eventId: string, ttlSec: number): Promise<void>;
  release(eventId: string): Promise<void>;
}

/** Thrown when another delivery of the same event is still in flight. */
export class PasswordResetDeliveryInFlightError extends Error {
  public constructor() {
    super('password reset delivery already in flight');
    this.name = 'PasswordResetDeliveryInFlightError';
  }
}

export interface PasswordResetConsumerDeps {
  readonly deliveries: PasswordResetDeliveryStore;
  readonly delivery: DeliverResetDeps;
}

export type PasswordResetConsumerOutcome = DeliverResetResult['kind'] | 'skipped_duplicate';

function logOutcome(eventId: string, outcome: PasswordResetConsumerOutcome): void {
  console.info('auth.password-reset.delivery', { eventId, outcome });
}

export async function handlePasswordResetRequested(
  event: AuthPasswordResetRequestedEvent,
  deps: PasswordResetConsumerDeps,
): Promise<PasswordResetConsumerOutcome> {
  const state = await deps.deliveries.begin(event.id, PASSWORD_RESET_IN_FLIGHT_TTL_SECONDS);
  if (state === 'completed') {
    logOutcome(event.id, 'skipped_duplicate');
    return 'skipped_duplicate';
  }
  if (state === 'in_flight') {
    throw new PasswordResetDeliveryInFlightError();
  }

  let result: DeliverResetResult;
  try {
    result = await deliverResetEmail(
      { requestId: event.id, userId: event.payload.userId },
      deps.delivery,
    );
  } catch (err) {
    try {
      await deps.deliveries.release(event.id);
    } catch (releaseErr) {
      // The in-flight mark then expires on its own; the original failure
      // is the one the queue must act on.
      console.error('auth.password-reset.delivery: release failed', {
        eventId: event.id,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
    throw err;
  }

  try {
    await deps.deliveries.complete(event.id, PASSWORD_RESET_COMPLETED_TTL_SECONDS);
  } catch (completeErr) {
    // The email is sent; failing now would only resend the same link,
    // which the provider deduplicates. Ack and let the mark expire.
    console.error('auth.password-reset.delivery: complete failed', {
      eventId: event.id,
      error: completeErr instanceof Error ? completeErr.message : String(completeErr),
    });
  }
  logOutcome(event.id, result.kind);
  return result.kind;
}
