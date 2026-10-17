/**
 * Unit tests for `buildPublishEvent` durability policy (issue #411).
 *
 * Covered:
 *   1. Compliance-critical event (auth.user.deleted): outbox failure rethrows.
 *   2. Compliance-critical event (auth.user.registered): outbox failure rethrows.
 *   3. Advisory event (auth.suspicious.login.anomaly): outbox failure swallowed + error logged.
 *   4. Outbox success + queue failure: completes (drain retries from outbox).
 *   5. Outbox success + queue success: completes cleanly.
 *   6. The outbox row goes through `auth_record_event` (migration 0033).
 *   7. `buildDispatchRecordedEvent` never writes the outbox and swallows
 *      queue failures (the event is already durable).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AthlyaBindings } from '../../types.js';
import type { AthlyaEvent } from '@athlya/shared/events';
import type { SQL } from 'drizzle-orm';

// -----------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------

const mockExecute = vi.fn().mockResolvedValue({ rows: [] });
const mockDbHttp = { execute: mockExecute };

vi.mock('../../adapters/deps-cache.js', () => ({
  getOrCreateDbHttp: vi.fn(() => mockDbHttp),
  getOrCreateRedisForEnv: vi.fn(() => ({})),
  primeDbHttpForTests: vi.fn(),
  resetAllDepsCachesForTests: vi.fn(),
  selectDb: vi.fn(() => mockDbHttp),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('../../events/publish.js', () => ({ publish: mockPublish }));

vi.mock('../../events/publish-deps.js', () => ({
  buildRoutedPublishDeps: vi.fn(() => ({})),
}));

// -----------------------------------------------------------------------
// Import after mocks are in place
// -----------------------------------------------------------------------

const { buildDispatchRecordedEvent, buildPublishEvent } =
  await import('../../adapters/auth-deps.js');
const { PgDialect } = await import('drizzle-orm/pg-core');

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

function makeEnv(): AthlyaBindings {
  return {
    DB_URL: 'postgresql://localhost/test',
    ENVIRONMENT: 'dev',
  } as unknown as AthlyaBindings;
}

function makeEvent(type: string): AthlyaEvent {
  return {
    id: 'evt-' + type,
    type,
    occurredAt: new Date().toISOString(),
  } as unknown as AthlyaEvent;
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('buildPublishEvent durability policy (issue #411)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [] });
    mockPublish.mockResolvedValue(undefined);
  });

  it('compliance-critical: rethrows outbox failure for auth.user.deleted', async () => {
    const dbError = new Error('SQLSTATE 42501: insufficient_privilege');
    mockExecute.mockRejectedValueOnce(dbError);

    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.user.deleted'))).rejects.toThrow(
      'insufficient_privilege',
    );
  });

  it('compliance-critical: rethrows outbox failure for auth.user.registered', async () => {
    const dbError = new Error('outbox write rejected');
    mockExecute.mockRejectedValueOnce(dbError);

    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.user.registered'))).rejects.toThrow(
      'outbox write rejected',
    );
  });

  it('advisory: swallows outbox failure and logs error for auth.suspicious.login.anomaly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dbError = new Error('network error');
    mockExecute.mockRejectedValueOnce(dbError);

    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.suspicious.login.anomaly'))).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      '[auth-deps] publishEvent: outbox write failed',
      expect.objectContaining({ critical: false, eventType: 'auth.suspicious.login.anomaly' }),
    );
    errorSpy.mockRestore();
  });

  it('outbox success + queue failure: completes — drain will retry', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPublish.mockRejectedValueOnce(new Error('queue unavailable'));

    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.user.deleted'))).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('queue publish failed'),
      expect.objectContaining({ eventType: 'auth.user.deleted' }),
    );
    warnSpy.mockRestore();
  });

  it('outbox success + queue success: completes cleanly', async () => {
    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.user.registered'))).resolves.toBeUndefined();

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('records the outbox row through auth_record_event', async () => {
    const event = makeEvent('auth.suspicious.login.anomaly');
    await buildPublishEvent(makeEnv())(event);

    const { sql, params } = new PgDialect().sqlToQuery(mockExecute.mock.calls[0]?.[0] as SQL);
    expect(sql).toContain('auth_record_event(');
    expect(params).toEqual([JSON.stringify(event)]);
  });
});

describe('buildDispatchRecordedEvent (issue #411)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublish.mockResolvedValue(undefined);
  });

  it('publishes to the queue without writing the outbox', async () => {
    await buildDispatchRecordedEvent(makeEnv())(makeEvent('auth.user.deleted'));

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('swallows a queue failure — the outbox drain delivers the event', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPublish.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(
      buildDispatchRecordedEvent(makeEnv())(makeEvent('auth.user.deleted')),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('drain will deliver'),
      expect.objectContaining({ eventType: 'auth.user.deleted' }),
    );
    warnSpy.mockRestore();
  });
});
