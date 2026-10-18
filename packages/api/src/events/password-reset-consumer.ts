/**
 * Consumer for `auth.password_reset.requested` (issue #645).
 *
 * The event is recorded by `auth_request_password_reset` (migration
 * 0042) when a reset is requested for a live account, drained from the
 * outbox onto the notifications lane, and handled here:
 *
 *   1. Claim `event.id` in the dedup store, so an at-least-once
 *      redelivery after a successful send does not email a second link
 *      (which would invalidate the first one).
 *   2. `deliverResetEmail` mints the token, stores its hash and sends
 *      the link.
 *   3. On failure the claim is released and the error rethrown: the
 *      dispatcher retries the message (`max_retries = 5`), then the
 *      queue moves it to `athlya-events-notifications-dlq`.
 *
 * Logs carry the event id and the outcome only: never the link, the
 * token or the recipient address.
 */

import { deliverResetEmail } from '@athlya/auth';
import { DEDUP_TTL_SECONDS } from '@athlya/notifications';

import type { DeliverResetDeps, DeliverResetResult } from '@athlya/auth';
import type { DedupStore } from '@athlya/notifications';
import type { AuthPasswordResetRequestedEvent } from '@athlya/shared/events';

export interface PasswordResetConsumerDeps {
  readonly dedup: DedupStore;
  readonly delivery: DeliverResetDeps;
}

export type PasswordResetConsumerOutcome = DeliverResetResult['kind'] | 'skipped_duplicate';

export async function handlePasswordResetRequested(
  event: AuthPasswordResetRequestedEvent,
  deps: PasswordResetConsumerDeps,
): Promise<PasswordResetConsumerOutcome> {
  const acquired = await deps.dedup.tryAcquire(event.id, DEDUP_TTL_SECONDS);
  if (!acquired) {
    console.info('auth.password-reset.delivery', {
      eventId: event.id,
      outcome: 'skipped_duplicate',
    });
    return 'skipped_duplicate';
  }

  let result: DeliverResetResult;
  try {
    result = await deliverResetEmail(event.payload.userId, deps.delivery);
  } catch (err) {
    try {
      await deps.dedup.release(event.id);
    } catch (releaseErr) {
      // The retry then sees the claim until it expires; the original
      // failure is the one the queue must act on.
      console.error('auth.password-reset.delivery: dedup release failed', {
        eventId: event.id,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
    throw err;
  }

  console.info('auth.password-reset.delivery', { eventId: event.id, outcome: result.kind });
  return result.kind;
}
