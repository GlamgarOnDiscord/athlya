/**
 * Property 5 — FIFO + idempotent offline drain (task 11.12).
 *
 * Validates Requirements 19.3, 19.4, 19.5, 19.6, 19.7, 20.1 and 20.3
 * against a fake idempotent server:
 *   - each mutation is applied at most once server-side (dedup by
 *     `Idempotency-Key`), even when a response is lost after the write;
 *   - mutations are applied in FIFO enqueue order;
 *   - losing the network or killing the app between drains loses nothing:
 *     every mutation is either still queued, dead-lettered, or applied by
 *     the server;
 *   - once drained, every valid mutation was applied exactly once and every
 *     invalid one sits in the dead-letter queue.
 *
 * A 409 is modelled the way the API's idempotency layer produces it: the
 * write is (or already was) applied and the server answers with a
 * conflict, so acknowledging it never hides a lost write.
 */
import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { NetworkError } from '../../infrastructure/api/errors';
import { createMemoryKeyValueStore } from '../../infrastructure/storage/key-value-store';
import { drainMutationQueue } from '../../infrastructure/sync/drain';
import { MutationQueue } from '../../infrastructure/sync/queue';

const OWNER = 'user-1';

import type { ApiClient, ApiResponse } from '../../infrastructure/api/client';

type Outcome =
  | 'ok'
  | 'conflict'
  | 'server-error-before-write'
  | 'server-error-after-write'
  | 'network-before-write'
  | 'network-after-write'
  | 'offline';

const outcomeArb = fc.constantFrom<Outcome>(
  'ok',
  'conflict',
  'server-error-before-write',
  'server-error-after-write',
  'network-before-write',
  'network-after-write',
  'offline',
);

interface MutationSpec {
  /** The server rejects it permanently (validation error → 422). */
  readonly invalid: boolean;
}

const scenarioArb = fc.record({
  batches: fc.array(fc.array(fc.record({ invalid: fc.boolean() }), { maxLength: 6 }), {
    minLength: 1,
    maxLength: 5,
  }),
  outcomes: fc.array(outcomeArb, { maxLength: 80 }),
  restartBetweenDrains: fc.boolean(),
});

class FakeIdempotentServer {
  /** Idempotency keys in the order the server applied them. */
  public readonly applied: string[] = [];
  readonly #replays = new Map<string, ApiResponse>();
  readonly #outcomes: Outcome[];
  readonly #invalidPaths: Set<string>;
  public online = true;

  public constructor(outcomes: Outcome[], invalidPaths: Set<string>) {
    this.#outcomes = [...outcomes];
    this.#invalidPaths = invalidPaths;
  }

  public readonly api: Pick<ApiClient, 'send'> = {
    send: (_method, path, _body, options) => {
      const key = options?.idempotencyKey;
      if (key === undefined) throw new Error('mutation sent without Idempotency-Key');
      if (!this.online) return Promise.reject(new NetworkError('offline'));
      const outcome = this.#outcomes.shift() ?? 'ok';
      switch (outcome) {
        case 'offline':
          this.online = false;
          return Promise.reject(new NetworkError('connection lost'));
        case 'network-before-write':
          return Promise.reject(new NetworkError('reset before write'));
        case 'server-error-before-write':
          return Promise.resolve(this.#response(503));
        case 'conflict': {
          const handled = this.#handle(key, path);
          return Promise.resolve(handled.status === 422 ? handled : this.#response(409));
        }
        case 'network-after-write':
          this.#handle(key, path);
          return Promise.reject(new NetworkError('response lost'));
        case 'server-error-after-write':
          this.#handle(key, path);
          return Promise.resolve(this.#response(500));
        case 'ok':
          return Promise.resolve(this.#handle(key, path));
      }
    },
  };

  #handle(key: string, path: string): ApiResponse {
    const replay = this.#replays.get(key);
    if (replay !== undefined) return replay;
    if (this.#invalidPaths.has(path)) return this.#response(422);
    this.applied.push(key);
    const response = this.#response(201);
    this.#replays.set(key, response);
    return response;
  }

  #response(status: number): ApiResponse {
    return { status, headers: new Headers(), body: null };
  }
}

describe('Property 5: FIFO + idempotent offline drain', () => {
  it('applies each mutation at most once, in FIFO order, and loses none across drains', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ batches, outcomes, restartBetweenDrains }) => {
        const disk = new Map<string, string>();
        const open = () => new MutationQueue(createMemoryKeyValueStore(disk), { uuid: randomUUID });
        let queue = open();

        const specs: MutationSpec[] = batches.flat();
        const invalidPaths = new Set(
          specs.flatMap((spec, index) => (spec.invalid ? [`/v1/m/${String(index)}`] : [])),
        );
        const server = new FakeIdempotentServer(outcomes, invalidPaths);
        const enqueueOrder: string[] = [];
        const pathOf = new Map<string, string>();

        const drain = () =>
          drainMutationQueue(queue, server.api, {
            ownerId: OWNER,
            isOnline: () => server.online,
            sleep: () => Promise.resolve(),
            random: () => 0,
          });

        const assertNothingLost = () => {
          const queued = new Set(queue.peek().map((m) => m.idempotencyKey));
          const dead = new Set(queue.deadLetters().map((m) => m.idempotencyKey));
          const applied = new Set(server.applied);
          for (const key of enqueueOrder) {
            const accounted = queued.has(key) || dead.has(key) || applied.has(key);
            expect(accounted, `mutation ${key} vanished`).toBe(true);
          }
        };

        let index = 0;
        for (const batch of batches) {
          for (const _spec of batch) {
            const path = `/v1/m/${String(index)}`;
            const mutation = queue.enqueue({
              ownerId: OWNER,
              kind: 'logSession',
              path,
              payload: { index },
            });
            enqueueOrder.push(mutation.idempotencyKey);
            pathOf.set(mutation.idempotencyKey, path);
            index += 1;
          }
          server.online = true;
          await drain();
          assertNothingLost();
          if (restartBetweenDrains) queue = open();
        }

        for (let round = 0; round < 200 && queue.size > 0; round += 1) {
          server.online = true;
          await drain();
          assertNothingLost();
          if (restartBetweenDrains) queue = open();
        }
        expect(queue.size).toBe(0);

        expect(new Set(server.applied).size).toBe(server.applied.length);

        const positions = server.applied.map((key) => enqueueOrder.indexOf(key));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));

        const dead = new Set(queue.deadLetters().map((m) => m.idempotencyKey));
        for (const key of enqueueOrder) {
          const invalid = invalidPaths.has(pathOf.get(key) ?? '');
          if (invalid) {
            expect(dead.has(key), `invalid mutation ${key} must be dead-lettered`).toBe(true);
            expect(server.applied.includes(key)).toBe(false);
          } else {
            expect(server.applied.includes(key), `mutation ${key} must be applied`).toBe(true);
            expect(dead.has(key)).toBe(false);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
