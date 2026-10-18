/**
 * Offline mutation queue persisted in MMKV — task 11.5, Requirements 19.1,
 * 19.2 and 20.3.
 *
 * - FIFO: entries are kept in enqueue order, and that order survives a
 *   restart because the whole list is written through to storage on every
 *   change.
 * - Every enqueued mutation gets a fresh UUID v4 `idempotencyKey`, sent as
 *   the `Idempotency-Key` header on each delivery attempt so the API
 *   applies it at most once. A caller that already sent the mutation online
 *   passes that key back so a retry cannot apply it twice.
 * - Every mutation records the user who made it (`ownerId`); the drain only
 *   sends a mutation under its owner's session.
 * - Permanently rejected mutations move to a dead-letter queue (DLQ) that
 *   the UI can show and the user can discard.
 */
import { z } from 'zod';

import { isUuidV4, type UuidV4Generator } from '../ids';

import type { KeyValueStore } from '../storage/key-value-store';

export const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type MutationMethod = (typeof MUTATION_METHODS)[number];

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

const PendingMutationSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().refine(isUuidV4, 'idempotencyKey must be a UUID v4'),
  ownerId: z.string().min(1),
  kind: z.string().min(1),
  method: z.enum(MUTATION_METHODS),
  path: z.string().startsWith('/'),
  payload: z.json(),
  enqueuedAt: z.iso.datetime(),
});

const DeadLetterSchema = PendingMutationSchema.extend({
  failedAt: z.iso.datetime(),
  status: z.number().int(),
  problemCode: z.string().optional(),
});

export type PendingMutation = z.infer<typeof PendingMutationSchema>;
export type DeadLetter = z.infer<typeof DeadLetterSchema>;

export interface MutationInput {
  /** Id of the signed-in user making the change. */
  readonly ownerId: string;
  /**
   * Reuse the key of a request already sent online (e.g. it timed out),
   * so the server deduplicates the retry. Defaults to a fresh UUID v4.
   */
  readonly idempotencyKey?: string;
  /** Domain intent, e.g. `logSession`, `bookClass`, `cancelReservation`. */
  readonly kind: string;
  readonly method?: MutationMethod;
  /** API path relative to the base URL, e.g. `/v1/sessions`. */
  readonly path: string;
  readonly payload?: JsonValue;
}

export interface DeadLetterReason {
  readonly status: number;
  readonly problemCode?: string | undefined;
}

export interface MutationQueueOptions {
  readonly uuid: UuidV4Generator;
  readonly now?: () => Date;
  /** Oldest dead letters are dropped beyond this many entries. */
  readonly maxDeadLetters?: number;
  /** Storage key namespace; one queue per namespace. */
  readonly namespace?: string;
}

const DEFAULT_MAX_DEAD_LETTERS = 200;
const DEFAULT_NAMESPACE = 'athlya.mutationQueue.v1';

export class MutationQueue {
  readonly #store: KeyValueStore;
  readonly #uuid: UuidV4Generator;
  readonly #now: () => Date;
  readonly #maxDeadLetters: number;
  readonly #queueKey: string;
  readonly #deadLetterKey: string;
  readonly #listeners = new Set<() => void>();
  #items: PendingMutation[];
  #deadLetters: DeadLetter[];

  public constructor(store: KeyValueStore, options: MutationQueueOptions) {
    this.#store = store;
    this.#uuid = options.uuid;
    this.#now = options.now ?? (() => new Date());
    this.#maxDeadLetters = options.maxDeadLetters ?? DEFAULT_MAX_DEAD_LETTERS;
    if (!Number.isInteger(this.#maxDeadLetters) || this.#maxDeadLetters < 1) {
      throw new Error('MutationQueue: maxDeadLetters must be a positive integer');
    }
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.#queueKey = `${namespace}.pending`;
    this.#deadLetterKey = `${namespace}.dead`;
    this.#items = this.#load(this.#queueKey, PendingMutationSchema);
    this.#deadLetters = this.#load(this.#deadLetterKey, DeadLetterSchema);
  }

  /** Appends a mutation with a fresh id and a UUID v4 idempotency key. */
  public enqueue(input: MutationInput): PendingMutation {
    const idempotencyKey = input.idempotencyKey ?? this.#uuid();
    if (!isUuidV4(idempotencyKey)) {
      throw new Error('MutationQueue: idempotency keys must be RFC 4122 v4 UUIDs');
    }
    const mutation: PendingMutation = {
      id: this.#uuid(),
      idempotencyKey,
      ownerId: input.ownerId,
      kind: input.kind,
      method: input.method ?? 'POST',
      path: input.path,
      payload: input.payload ?? null,
      enqueuedAt: this.#now().toISOString(),
    };
    const parsed = PendingMutationSchema.parse(mutation);
    this.#items = [...this.#items, parsed];
    this.#persistQueue();
    return parsed;
  }

  /** FIFO snapshot of the pending mutations. */
  public peek(): readonly PendingMutation[] {
    return [...this.#items];
  }

  public get size(): number {
    return this.#items.length;
  }

  public has(id: string): boolean {
    return this.#items.some((item) => item.id === id);
  }

  /** Removes a pending mutation; returns `false` when it is not queued. */
  public remove(id: string): boolean {
    const next = this.#items.filter((item) => item.id !== id);
    if (next.length === this.#items.length) return false;
    this.#items = next;
    this.#persistQueue();
    return true;
  }

  /**
   * Yields the mutations queued when iteration starts, in FIFO order,
   * skipping any removed in the meantime. Mutations enqueued during the
   * iteration wait for the next drain.
   */
  public drain(): AsyncIterableIterator<PendingMutation, undefined> {
    const snapshot = this.peek();
    let index = 0;
    const iterator: AsyncIterableIterator<PendingMutation, undefined> = {
      next: () => {
        while (index < snapshot.length) {
          const mutation = snapshot[index];
          index += 1;
          if (mutation !== undefined && this.has(mutation.id)) {
            return Promise.resolve({ done: false, value: mutation });
          }
        }
        return Promise.resolve({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  /**
   * Moves a pending mutation to the DLQ. The DLQ is written before the
   * pending list, so a crash in between can duplicate the entry but never
   * lose it.
   */
  public moveToDeadLetter(id: string, reason: DeadLetterReason): boolean {
    const mutation = this.#items.find((item) => item.id === id);
    if (!mutation) return false;
    const deadLetter: DeadLetter = {
      ...mutation,
      failedAt: this.#now().toISOString(),
      status: reason.status,
      ...(reason.problemCode === undefined ? {} : { problemCode: reason.problemCode }),
    };
    this.#deadLetters = [...this.#deadLetters, deadLetter].slice(-this.#maxDeadLetters);
    this.#store.set(this.#deadLetterKey, JSON.stringify(this.#deadLetters));
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#persistQueue();
    return true;
  }

  /** The given user's pending mutations, in FIFO order; none for `null`. */
  public pendingFor(ownerId: string | null): readonly PendingMutation[] {
    return this.#items.filter((item) => ownerId !== null && item.ownerId === ownerId);
  }

  /** The given user's dead letters; none for `null`, so no account sees another's. */
  public deadLetters(ownerId: string | null): readonly DeadLetter[] {
    return this.#deadLetters.filter((item) => ownerId !== null && item.ownerId === ownerId);
  }

  /** Discards one of the given user's dead letters; `false` for anyone else's. */
  public discardDeadLetter(id: string, ownerId: string | null): boolean {
    const next = this.#deadLetters.filter(
      (item) => item.id !== id || ownerId === null || item.ownerId !== ownerId,
    );
    if (next.length === this.#deadLetters.length) return false;
    this.#deadLetters = next;
    this.#store.set(this.#deadLetterKey, JSON.stringify(this.#deadLetters));
    this.#notify();
    return true;
  }

  /** Notified after every change to the pending list or the DLQ. */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #persistQueue(): void {
    this.#store.set(this.#queueKey, JSON.stringify(this.#items));
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  /**
   * Reads a persisted list. A payload that does not parse is kept aside
   * under `<key>.corrupt` instead of being overwritten, so no queued
   * mutation is silently lost.
   */
  #load<T>(key: string, schema: z.ZodType<T>): T[] {
    const raw = this.#store.getString(key);
    if (raw === undefined) return [];
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = undefined;
    }
    const parsed = z.array(schema).safeParse(decoded);
    if (parsed.success) return parsed.data;
    this.#store.set(`${key}.corrupt`, raw);
    this.#store.remove(key);
    return [];
  }
}
