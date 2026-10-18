/**
 * `drainMutationQueue` — task 11.6, design.md Algorithm 4, Requirements
 * 19.3 to 19.7.
 *
 * For each queued mutation, in FIFO order:
 *   - stop the whole drain as soon as the device is offline;
 *   - send it with its `Idempotency-Key`;
 *   - 2xx or 409 (already applied) → remove it from the queue;
 *   - any other 4xx → move it to the dead-letter queue;
 *   - 5xx or a network failure → retry with exponential backoff,
 *     `min(2^attempt × 1 s, 30 s) + jitter`, up to 5 attempts; when every
 *     attempt fails, leave it queued and stop the drain so later mutations
 *     never overtake it.
 *
 * Refinements over the pseudocode, each keeping its postconditions:
 *   - every 2xx acknowledges (the pseudocode lists 200/201/202, but its
 *     postcondition and Requirement 19.4 say 2xx; `DELETE` answers 204);
 *   - 408 and 429 are transient: the API did not apply the mutation, so
 *     dead-lettering it would lose a valid write;
 *   - a session that cannot be refreshed (`AuthRequiredError`) stops the
 *     drain without touching the queue, like a network loss;
 *   - connectivity is also checked before every retry, so a network loss
 *     during backoff stops the drain (`offline`) instead of burning the
 *     remaining attempts;
 *   - no sleep follows the last failed attempt, since nothing is sent
 *     after it;
 *   - only the signed-in user's mutations are sent (`ownerId`); another
 *     account's entries stay queued, in order, until that user signs in
 *     again, and nothing is sent without a session.
 */
import { parseProblem } from '../api/client';
import { AuthRequiredError } from '../api/errors';

import type { MutationQueue, PendingMutation } from './queue';
import type { ApiClient } from '../api/client';

export type DeliveryOutcome = 'acknowledged' | 'rejected' | 'transient';

export type DrainStopReason = 'completed' | 'offline' | 'retries-exhausted' | 'auth-required';

export interface DrainProgress {
  /** Mutations queued when the drain started. */
  readonly total: number;
  /** Mutations settled so far (acknowledged or dead-lettered). */
  readonly processed: number;
  readonly current: PendingMutation | null;
}

export interface DrainResult {
  readonly acknowledged: number;
  readonly deadLettered: number;
  readonly remaining: number;
  readonly stoppedBy: DrainStopReason;
}

export interface DrainOptions {
  /** Connectivity probe, checked before each mutation and each retry. */
  readonly isOnline: () => boolean;
  /** Signed-in user; only their mutations are sent. `null` sends nothing. */
  readonly ownerId: string | null;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxJitterMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Uniform random source in `[0, 1)` for the jitter. */
  readonly random?: () => number;
  readonly onProgress?: (progress: DrainProgress) => void;
  /**
   * Re-checked before every attempt: resolves `false` once `ownerId` is no
   * longer the signed-in user (sign-out, account deletion, another sign-in),
   * which stops the drain with `auth-required` so a mutation is never sent
   * under another account's session.
   */
  readonly isOwnerSignedIn?: () => Promise<boolean>;
}

export const DRAIN_DEFAULTS = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxJitterMs: 1_000,
} as const;

export function classifyStatus(status: number): DeliveryOutcome {
  if ((status >= 200 && status < 300) || status === 409) return 'acknowledged';
  if (status === 408 || status === 429) return 'transient';
  if (status >= 400 && status < 500) return 'rejected';
  return 'transient';
}

/** Delay before the retry that follows failed attempt number `attempt` (1-based). */
export function backoffDelayMs(
  attempt: number,
  random: () => number,
  options: Pick<DrainOptions, 'baseDelayMs' | 'maxDelayMs' | 'maxJitterMs'> = {},
): number {
  const base = options.baseDelayMs ?? DRAIN_DEFAULTS.baseDelayMs;
  const max = options.maxDelayMs ?? DRAIN_DEFAULTS.maxDelayMs;
  const jitter = options.maxJitterMs ?? DRAIN_DEFAULTS.maxJitterMs;
  return Math.min(2 ** attempt * base, max) + Math.floor(random() * jitter);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function drainMutationQueue(
  queue: MutationQueue,
  api: Pick<ApiClient, 'send'>,
  options: DrainOptions,
): Promise<DrainResult> {
  const maxAttempts = options.maxAttempts ?? DRAIN_DEFAULTS.maxAttempts;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const ownerId = options.ownerId;
  const total = queue.pendingFor(ownerId).length;
  let processed = 0;
  let acknowledged = 0;
  let deadLettered = 0;
  let stoppedBy: DrainStopReason = 'completed';

  const report = (current: PendingMutation | null): void => {
    options.onProgress?.({ total, processed, current });
  };
  report(null);
  if (ownerId === null) {
    return { acknowledged, deadLettered, remaining: queue.size, stoppedBy: 'auth-required' };
  }

  outer: for await (const mutation of queue.drain()) {
    if (mutation.ownerId !== ownerId) continue;
    if (!options.isOnline()) {
      stoppedBy = 'offline';
      break;
    }
    report(mutation);

    let attempt = 0;
    let settled = false;
    while (attempt < maxAttempts && !settled) {
      if (options.isOwnerSignedIn !== undefined && !(await options.isOwnerSignedIn())) {
        stoppedBy = 'auth-required';
        break outer;
      }
      // Removed meanwhile (discarded by its owner, account deleted): nothing to send.
      if (!queue.has(mutation.id)) {
        settled = true;
        break;
      }
      let outcome: DeliveryOutcome;
      let status = 0;
      let body: unknown = null;
      try {
        const response = await api.send(
          mutation.method,
          mutation.path,
          mutation.payload === null ? undefined : mutation.payload,
          { idempotencyKey: mutation.idempotencyKey },
        );
        status = response.status;
        body = response.body;
        outcome = classifyStatus(status);
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          stoppedBy = 'auth-required';
          break outer;
        }
        outcome = 'transient';
      }

      if (outcome === 'acknowledged') {
        queue.remove(mutation.id);
        acknowledged += 1;
        settled = true;
      } else if (outcome === 'rejected') {
        queue.moveToDeadLetter(mutation.id, { status, problemCode: parseProblem(body)?.code });
        deadLettered += 1;
        settled = true;
      } else {
        attempt += 1;
        if (attempt < maxAttempts) {
          await sleep(backoffDelayMs(attempt, random, options));
          if (!options.isOnline()) {
            stoppedBy = 'offline';
            break outer;
          }
        }
      }
    }

    if (!settled) {
      stoppedBy = 'retries-exhausted';
      break;
    }
    processed += 1;
    report(null);
  }

  return { acknowledged, deadLettered, remaining: queue.size, stoppedBy };
}
