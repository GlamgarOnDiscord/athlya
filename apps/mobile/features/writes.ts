/**
 * The single write path of the screens (Requirements 19.1, 20.1, 20.3).
 *
 * - Online, with nothing of this user still queued: the request goes out
 *   directly with a fresh UUID v4 `Idempotency-Key`.
 * - On `NetworkError` the same request is queued **with the same key**, so
 *   a write that did reach the server is not applied twice when the drain
 *   replays it, and a drain starts.
 * - Offline, or while older writes of this user wait in the queue, the
 *   write is queued straight away: sending it directly could apply it
 *   before the queued ones and break the FIFO order of the drain.
 * - A request cancelled through `signal` rethrows its abort error and is
 *   never queued; API errors (4xx/5xx) are rethrown for the screen.
 */
import { AuthRequiredError, NetworkError } from '../infrastructure/api/errors';

import { createAbortError } from './errors';

import type { ApiClient, RequestOptions } from '../infrastructure/api/client';
import type { UuidV4Generator } from '../infrastructure/ids';
import type {
  JsonValue,
  MutationMethod,
  MutationQueue,
  PendingMutation,
} from '../infrastructure/sync/queue';
import type { SyncController } from '../infrastructure/sync/sync-controller';

export interface WriteDeps {
  readonly api: Pick<ApiClient, 'post' | 'put' | 'patch' | 'del'>;
  readonly queue: Pick<MutationQueue, 'enqueue' | 'pendingFor'>;
  readonly sync: Pick<SyncController, 'syncNow' | 'getState'>;
  /** Signed-in user id; owns the queued mutation. */
  readonly getOwnerId: () => Promise<string | null>;
  readonly uuid: UuidV4Generator;
}

export interface WriteInput {
  /** Domain intent recorded in the queue, e.g. `bookClass`. */
  readonly kind: string;
  readonly method: MutationMethod;
  readonly path: string;
  readonly payload?: JsonValue;
  readonly signal?: AbortSignal;
}

export type WriteOutcome<T> =
  | { readonly kind: 'sent'; readonly body: T }
  | { readonly kind: 'queued'; readonly mutation: PendingMutation };

/** Read through a call so the check is not narrowed away across an `await`. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * A JSON copy of a request body for the queue: drops `undefined` fields,
 * which are absent on the wire anyway.
 */
export function toJsonPayload(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function send<T>(api: WriteDeps['api'], input: WriteInput, options: RequestOptions): Promise<T> {
  // Same body as the drain sends for a queued copy: no body for a null payload.
  const body = input.payload === null ? undefined : input.payload;
  switch (input.method) {
    case 'POST':
      return api.post<T>(input.path, body, options);
    case 'PUT':
      return api.put<T>(input.path, body, options);
    case 'PATCH':
      return api.patch<T>(input.path, body, options);
    case 'DELETE':
      return api.del<T>(input.path, options);
  }
}

function enqueue(
  deps: WriteDeps,
  ownerId: string,
  input: WriteInput,
  idempotencyKey: string,
): WriteOutcome<never> {
  const mutation = deps.queue.enqueue({
    ownerId,
    kind: input.kind,
    method: input.method,
    path: input.path,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    idempotencyKey,
  });
  void deps.sync.syncNow();
  return { kind: 'queued', mutation };
}

export async function submitWrite<T>(deps: WriteDeps, input: WriteInput): Promise<WriteOutcome<T>> {
  const ownerId = await deps.getOwnerId();
  if (ownerId === null) throw new AuthRequiredError();
  if (isAborted(input.signal)) throw createAbortError();
  const idempotencyKey = deps.uuid();

  const offline = deps.sync.getState().status === 'offline';
  if (offline || deps.queue.pendingFor(ownerId).length > 0) {
    return enqueue(deps, ownerId, input, idempotencyKey);
  }

  try {
    const body = await send<T>(deps.api, input, {
      idempotencyKey,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { kind: 'sent', body };
  } catch (error) {
    if (!(error instanceof NetworkError) || isAborted(input.signal)) throw error;
    return enqueue(deps, ownerId, input, idempotencyKey);
  }
}
