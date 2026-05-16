/**
 * Unit tests for the append-only audit log writer.
 *
 * The module is a thin validation + delegation layer, so the tests
 * exercise it directly with a {@link vi.fn}-backed
 * {@link AuditLogStore} double. No Postgres, no Hono, no transaction
 * machinery — the DI port is the whole seam.
 *
 * Coverage mirrors the scenarios called out in task 8.10:
 *
 *   1. Happy path — `store.append` is called exactly once with the
 *      entry shape verbatim (plus the defaulted `metadata`), and the
 *      same opaque `tx` value the caller passed in.
 *   2. `actorId: null` — accepted (anonymous / RGPD-anonymised rows).
 *   3. Empty `action` is rejected with a {@link ZodError}.
 *   4. `action` > 128 chars is rejected.
 *   5. `targetType` > 64 chars is rejected.
 *   6. `targetId` > 128 chars is rejected.
 *   7. `metadata` defaults to `{}` when omitted.
 *   8. Propagation — a {@link AuditLogStore.append} rejection flows
 *      through `appendAudit` unmodified, so the enclosing transaction
 *      rolls back (Req 22.2).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AUDIT_ACTIONS, appendAudit, type AuditEntry, type AuditLogStore } from '../audit.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Opaque tx handle — the writer must forward it untouched. */
const FAKE_TX = { __tag: 'fake-tx' };

/**
 * Build a fresh fake store per test so call-count assertions do not
 * leak across cases. The returned object doubles as a `vi.fn()` spy.
 */
function makeStore(): { store: AuditLogStore; append: ReturnType<typeof vi.fn> } {
  const append = vi.fn().mockResolvedValue(undefined);
  return {
    append,
    store: { append },
  };
}

const VALID_ACTOR = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('appendAudit', () => {
  it('happy path: calls store.append exactly once with the entry verbatim', async () => {
    const { store, append } = makeStore();
    const entry: AuditEntry = {
      actorId: VALID_ACTOR,
      action: 'user.registered',
      targetType: 'user',
      targetId: VALID_ACTOR,
      metadata: { email_domain: 'example.com' },
    };

    await appendAudit(FAKE_TX, entry, store);

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(FAKE_TX, {
      actorId: VALID_ACTOR,
      action: 'user.registered',
      targetType: 'user',
      targetId: VALID_ACTOR,
      metadata: { email_domain: 'example.com' },
    });
  });

  it('accepts actorId: null for anonymous / anonymised actions', async () => {
    const { store, append } = makeStore();

    await appendAudit(
      FAKE_TX,
      {
        actorId: null,
        action: 'rls.violation',
        targetType: 'reservations',
        metadata: { path: '/v1/reservations' },
      },
      store,
    );

    expect(append).toHaveBeenCalledTimes(1);
    const forwarded = append.mock.calls[0]?.[1] as AuditEntry;
    expect(forwarded.actorId).toBeNull();
    expect(forwarded.action).toBe('rls.violation');
  });

  it('defaults metadata to {} when the caller omits it', async () => {
    const { store, append } = makeStore();

    await appendAudit(
      FAKE_TX,
      {
        actorId: VALID_ACTOR,
        action: 'user.deleted',
        targetType: 'user',
        targetId: VALID_ACTOR,
      },
      store,
    );

    const forwarded = append.mock.calls[0]?.[1] as AuditEntry;
    expect(forwarded.metadata).toEqual({});
  });

  it('forwards the opaque tx handle verbatim (no introspection)', async () => {
    const { store, append } = makeStore();
    const opaque = Symbol('tx-sentinel');

    await appendAudit(
      opaque,
      {
        actorId: VALID_ACTOR,
        action: 'billing.stripe.signature_failed',
        metadata: { request_id: 'req_123' },
      },
      store,
    );

    expect(append.mock.calls[0]?.[0]).toBe(opaque);
  });

  it('rejects an empty action with a ZodError', async () => {
    const { store, append } = makeStore();

    await expect(
      appendAudit(
        FAKE_TX,
        {
          actorId: VALID_ACTOR,
          action: '',
        },
        store,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects an action longer than 128 characters', async () => {
    const { store, append } = makeStore();

    await expect(
      appendAudit(
        FAKE_TX,
        {
          actorId: VALID_ACTOR,
          action: 'a'.repeat(129),
        },
        store,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(append).not.toHaveBeenCalled();
  });

  it('accepts an action exactly 128 characters long (boundary)', async () => {
    const { store, append } = makeStore();

    await appendAudit(
      FAKE_TX,
      {
        actorId: VALID_ACTOR,
        action: 'a'.repeat(128),
      },
      store,
    );

    expect(append).toHaveBeenCalledTimes(1);
  });

  it('rejects a targetType longer than 64 characters', async () => {
    const { store, append } = makeStore();

    await expect(
      appendAudit(
        FAKE_TX,
        {
          actorId: VALID_ACTOR,
          action: 'user.registered',
          targetType: 't'.repeat(65),
        },
        store,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects a targetId longer than 128 characters', async () => {
    const { store, append } = makeStore();

    await expect(
      appendAudit(
        FAKE_TX,
        {
          actorId: VALID_ACTOR,
          action: 'reservation.cancelled_by_admin',
          targetType: 'reservation',
          targetId: 'x'.repeat(129),
        },
        store,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(append).not.toHaveBeenCalled();
  });

  it('propagates store rejections unchanged (Req 22.2: rollback on failure)', async () => {
    const append = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const store: AuditLogStore = { append };

    await expect(
      appendAudit(
        FAKE_TX,
        {
          actorId: VALID_ACTOR,
          action: 'user.registered',
        },
        store,
      ),
    ).rejects.toThrow(/db unavailable/);
  });

  it('does not catch store rejections (the original error reaches the caller)', async () => {
    class CustomError extends Error {
      public override readonly name = 'CustomError';
    }
    const append = vi.fn().mockRejectedValue(new CustomError('boom'));
    const store: AuditLogStore = { append };

    await expect(
      appendAudit(
        FAKE_TX,
        {
          actorId: null,
          action: 'user.deleted',
        },
        store,
      ),
    ).rejects.toBeInstanceOf(CustomError);
  });

  it('exposes AUDIT_ACTIONS as a tuple of the six wired slugs', () => {
    expect(AUDIT_ACTIONS).toEqual([
      'user.registered',
      'user.deleted',
      'reservation.cancelled_by_admin',
      'rls.violation',
      'billing.stripe.signature_failed',
      'user.consents.updated',
    ]);
  });
});
