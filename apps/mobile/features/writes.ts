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
 *   before the queued ones and break the FIFO order of the drain. Writes of
 *   one user are serialized for the same reason (see `serialized`).
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

/**
 * Tail of the write chain per queue and owner. Writes of one user run one
 * at a time, so a newer write only decides "send or queue" once every older
 * one has either been acknowledged or taken its place in the queue: an
 * older write that fails with `NetworkError` is always queued first.
 */
const writeChains = new WeakMap<object, Map<string, Promise<void>>>();

function serialized<R>(queue: object, ownerId: string, task: () => Promise<R>): Promise<R> {
  let chains = writeChains.get(queue);
  if (chains === undefined) {
    chains = new Map();
    writeChains.set(queue, chains);
  }
  const owned = chains;
  const previous = owned.get(ownerId) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  owned.set(ownerId, tail);
  void tail.then(() => {
    if (owned.get(ownerId) === tail) owned.delete(ownerId);
  });
  return run;
}

export async function submitWrite<T>(deps: WriteDeps, input: WriteInput): Promise<WriteOutcome<T>> {
  const ownerId = await deps.getOwnerId();
  if (ownerId === null) throw new AuthRequiredError();
  return serialized(deps.queue, ownerId, () => submitInOrder<T>(deps, ownerId, input));
}

async function submitInOrder<T>(
  deps: WriteDeps,
  ownerId: string,
  input: WriteInput,
): Promise<WriteOutcome<T>> {
  if (isAborted(input.signal)) throw createAbortError();
  const idempotencyKey = deps.uuid();

  // The write may have waited behind older ones: if the signed-in user changed
  // meanwhile, the API client now holds another account's session. Never send
  // it directly then; queue it for the user who made it, whose session the
  // drain will use once they sign in again.
  let currentOwner: string | null;
  try {
    currentOwner = await deps.getOwnerId();
  } catch {
    currentOwner = null;
  }
  const offline = deps.sync.getState().status === 'offline';
  if (currentOwner !== ownerId || offline || deps.queue.pendingFor(ownerId).length > 0) {
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
