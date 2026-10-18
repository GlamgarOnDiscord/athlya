import { describe, expect, it } from 'vitest';

import { isUuidV4 } from '../../infrastructure/ids';
import { createMemoryKeyValueStore } from '../../infrastructure/storage/key-value-store';
import { MutationQueue } from '../../infrastructure/sync/queue';
import { createQueue } from '../helpers';

const PENDING_KEY = 'athlya.mutationQueue.v1.pending';

describe('MutationQueue', () => {
  it('assigns a fresh UUID v4 idempotency key to every enqueued mutation', () => {
    const { queue } = createQueue();
    const first = queue.enqueue({ kind: 'logSession', path: '/v1/sessions', payload: { a: 1 } });
    const second = queue.enqueue({ kind: 'logSession', path: '/v1/sessions', payload: { a: 1 } });

    expect(isUuidV4(first.idempotencyKey)).toBe(true);
    expect(isUuidV4(second.idempotencyKey)).toBe(true);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.id).not.toBe(second.id);
    expect(first.method).toBe('POST');
  });

  it('rejects a uuid generator that does not produce v4 UUIDs', () => {
    const queue = new MutationQueue(createMemoryKeyValueStore(), { uuid: () => 'not-a-uuid' });
    expect(() => queue.enqueue({ kind: 'bookClass', path: '/v1/reservations' })).toThrow(/v4/u);
  });

  it('keeps FIFO order and supports peek / remove', () => {
    const { queue } = createQueue();
    const a = queue.enqueue({ kind: 'a', path: '/v1/a' });
    const b = queue.enqueue({ kind: 'b', path: '/v1/b' });
    const c = queue.enqueue({ kind: 'c', path: '/v1/c' });

    expect(queue.peek().map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(queue.remove(b.id)).toBe(true);
    expect(queue.remove(b.id)).toBe(false);
    expect(queue.peek().map((m) => m.id)).toEqual([a.id, c.id]);
    expect(queue.size).toBe(2);
  });

  it('drain() yields the snapshot in FIFO order and skips entries removed meanwhile', async () => {
    const { queue } = createQueue();
    const a = queue.enqueue({ kind: 'a', path: '/v1/a' });
    const b = queue.enqueue({ kind: 'b', path: '/v1/b' });
    const c = queue.enqueue({ kind: 'c', path: '/v1/c' });

    const seen: string[] = [];
    for await (const mutation of queue.drain()) {
      seen.push(mutation.id);
      if (mutation.id === a.id) {
        queue.remove(b.id);
        queue.enqueue({ kind: 'd', path: '/v1/d' });
      }
    }
    expect(seen).toEqual([a.id, c.id]);
  });

  it('moves a mutation to the dead-letter queue with its failure status', () => {
    const { queue } = createQueue();
    const a = queue.enqueue({
      kind: 'bookClass',
      path: '/v1/reservations',
      payload: { classId: 'x' },
    });

    expect(queue.moveToDeadLetter(a.id, { status: 422, problemCode: 'class_in_past' })).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.deadLetters()).toEqual([
      expect.objectContaining({ id: a.id, status: 422, problemCode: 'class_in_past' }),
    ]);
    expect(queue.discardDeadLetter(a.id)).toBe(true);
    expect(queue.deadLetters()).toEqual([]);
  });

  it('caps the dead-letter queue, dropping the oldest entries', () => {
    const capped = new MutationQueue(createMemoryKeyValueStore(), {
      uuid: () => crypto.randomUUID(),
      maxDeadLetters: 2,
    });
    const ids = [1, 2, 3].map((n) => capped.enqueue({ kind: `k${String(n)}`, path: '/v1/x' }).id);
    for (const id of ids) capped.moveToDeadLetter(id, { status: 400 });
    expect(capped.deadLetters().map((d) => d.id)).toEqual(ids.slice(1));
  });

  it('notifies subscribers on every change', () => {
    const { queue } = createQueue();
    let calls = 0;
    const unsubscribe = queue.subscribe(() => {
      calls += 1;
    });
    const a = queue.enqueue({ kind: 'a', path: '/v1/a' });
    queue.moveToDeadLetter(a.id, { status: 400 });
    unsubscribe();
    queue.enqueue({ kind: 'b', path: '/v1/b' });
    expect(calls).toBe(2);
  });
});

describe('MutationQueue persistence (task 11.13)', () => {
  it('restores the same items in the same order after the app is killed and restarted', async () => {
    const disk = new Map<string, string>();
    const before = createQueue(disk).queue;
    const enqueued = [
      before.enqueue({ kind: 'logSession', path: '/v1/sessions', payload: { sets: [1, 2] } }),
      before.enqueue({ kind: 'bookClass', path: '/v1/reservations', payload: { classId: 'c1' } }),
      before.enqueue({ kind: 'cancelReservation', method: 'DELETE', path: '/v1/reservations/r1' }),
    ];

    const after = createQueue(disk).queue;

    expect(after.peek()).toEqual(enqueued);
    const drained: unknown[] = [];
    for await (const mutation of after.drain()) drained.push(mutation);
    expect(drained).toEqual(enqueued);
  });

  it('persists removals and dead letters across restarts', () => {
    const disk = new Map<string, string>();
    const before = createQueue(disk).queue;
    const a = before.enqueue({ kind: 'a', path: '/v1/a' });
    const b = before.enqueue({ kind: 'b', path: '/v1/b' });
    const c = before.enqueue({ kind: 'c', path: '/v1/c' });
    before.remove(a.id);
    before.moveToDeadLetter(b.id, { status: 404 });

    const after = createQueue(disk).queue;

    expect(after.peek().map((m) => m.id)).toEqual([c.id]);
    expect(after.deadLetters().map((d) => d.id)).toEqual([b.id]);
  });

  it('keeps idempotency keys stable across restarts', () => {
    const disk = new Map<string, string>();
    const original = createQueue(disk).queue.enqueue({ kind: 'a', path: '/v1/a' });
    const restored = createQueue(disk).queue.peek()[0];
    expect(restored?.idempotencyKey).toBe(original.idempotencyKey);
  });

  it('sets a corrupt payload aside instead of discarding it', () => {
    const disk = new Map<string, string>([[PENDING_KEY, '{not json']]);
    const { queue } = createQueue(disk);

    expect(queue.size).toBe(0);
    expect(disk.get(`${PENDING_KEY}.corrupt`)).toBe('{not json');
    expect(disk.has(PENDING_KEY)).toBe(false);
  });

  it('sets aside a payload whose entries fail validation', () => {
    const invalid = JSON.stringify([{ id: 'x', idempotencyKey: 'nope' }]);
    const disk = new Map<string, string>([[PENDING_KEY, invalid]]);
    createQueue(disk);
    expect(disk.get(`${PENDING_KEY}.corrupt`)).toBe(invalid);
  });
});
