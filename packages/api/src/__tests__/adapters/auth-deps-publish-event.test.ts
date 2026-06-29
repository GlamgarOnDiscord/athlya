/**
 * Unit tests for `buildPublishEvent` durability policy (issue #411).
 *
 * Covered:
 *   1. Compliance-critical event (auth.user.deleted): outbox failure rethrows.
 *   2. Compliance-critical event (auth.user.registered): outbox failure rethrows.
 *   3. Advisory event (auth.login.suspicious): outbox failure swallowed + error logged.
 *   4. Outbox success + queue failure: completes (drain retries from outbox).
 *   5. Outbox success + queue success: completes cleanly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AthlyaBindings } from '../../types.js';
import type { AthlyaEvent } from '@athlya/shared/events';

// -----------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------

const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing }));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockDbHttp = { insert: mockInsert };

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

const { buildPublishEvent } = await import('../../adapters/auth-deps.js');

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
    mockOnConflictDoNothing.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  });

  it('compliance-critical: rethrows outbox failure for auth.user.deleted', async () => {
    const dbError = new Error('SQLSTATE 42501: insufficient_privilege');
    mockOnConflictDoNothing.mockRejectedValueOnce(dbError);

    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.user.deleted'))).rejects.toThrow(
      'insufficient_privilege',
    );
  });

  it('compliance-critical: rethrows outbox failure for auth.user.registered', async () => {
    const dbError = new Error('outbox write rejected');
    mockOnConflictDoNothing.mockRejectedValueOnce(dbError);

    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.user.registered'))).rejects.toThrow(
      'outbox write rejected',
    );
  });

  it('advisory: swallows outbox failure and logs error for auth.login.suspicious', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dbError = new Error('network error');
    mockOnConflictDoNothing.mockRejectedValueOnce(dbError);

    const publishEvent = buildPublishEvent(makeEnv());
    await expect(publishEvent(makeEvent('auth.login.suspicious'))).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      '[auth-deps] publishEvent: outbox write failed',
      expect.objectContaining({ critical: false, eventType: 'auth.login.suspicious' }),
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

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
