import { createTranslator } from '@athlya/shared/i18n';
import { describe, expect, it } from 'vitest';

import {
  connectAppleHealth,
  disconnectAppleHealth,
  healthNotice,
  importAppleHealthWorkouts,
  IMPORT_HEALTH_WORKOUT_KIND,
  INITIAL_LOOKBACK_DAYS,
  PAGE_SIZE,
  stoppedNotice,
  type AppleHealthDeps,
} from '../../features/health/apple-health';
import { importIdempotencyKey } from '../../features/health/workout-mapping';
import { ApiError, NetworkError } from '../../infrastructure/api/errors';
import { AppleHealthLinkStore } from '../../infrastructure/health/link-store';
import { createMemoryKeyValueStore } from '../../infrastructure/storage/key-value-store';
import { createWriteDeps, USER_ID } from '../features-helpers';
import { FakeHealthStore, sha256, workout } from '../health-helpers';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const DAY_MS = 86_400_000;
const PROFILE = (thirdParty: boolean) => ({
  id: USER_ID,
  displayName: 'Member',
  consents: {
    marketing: false,
    analytics: false,
    thirdParty,
    version: '2026-01',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
});

function setup(options: { consent?: boolean; status?: 'idle' | 'offline' } = {}) {
  const health = new FakeHealthStore();
  const links = new AppleHealthLinkStore(createMemoryKeyValueStore());
  const write = createWriteDeps({ ownerId: USER_ID, status: options.status ?? 'idle' });
  write.api.get.mockResolvedValue(PROFILE(options.consent ?? true));
  write.api.post.mockResolvedValue({ id: 'session' });
  const deps: AppleHealthDeps = {
    health,
    links,
    api: write.api,
    writes: write.deps,
    sha256,
    t: createTranslator('en'),
    locale: 'en',
    now: () => NOW,
  };
  return { ...write, deps, health, links };
}

function workouts(count: number, offsetMs = 0) {
  return Array.from({ length: count }, (_, i) =>
    workout({
      uuid: `HK-${String(i).padStart(4, '0')}`,
      startDate: new Date(NOW - 10 * DAY_MS + offsetMs + i * 60_000),
      endDate: new Date(NOW - 10 * DAY_MS + offsetMs + i * 60_000 + 1_800_000),
      duration: { unit: 's', quantity: 1800 },
    }),
  );
}

const postedKeys = (post: { mock: { calls: unknown[][] } }) =>
  post.mock.calls.map((call) => (call[2] as { idempotencyKey: string }).idempotencyKey);

describe('connectAppleHealth', () => {
  it('asks for read access and links the user from 30 days back', async () => {
    const { deps, health, links, api } = setup();

    expect(await connectAppleHealth(deps, USER_ID)).toEqual({ kind: 'connected' });

    expect(api.get).toHaveBeenCalledWith('/v1/members/me');
    expect(health.requestReadAuthorization).toHaveBeenCalledTimes(1);
    expect(links.get(USER_ID)).toEqual({
      sinceMs: NOW - INITIAL_LOOKBACK_DAYS * DAY_MS,
      anchor: null,
    });
  });

  it('needs the thirdParty consent before showing the permission sheet', async () => {
    const { deps, health, links } = setup({ consent: false });

    expect(await connectAppleHealth(deps, USER_ID)).toEqual({ kind: 'consentRequired' });

    expect(health.requestReadAuthorization).not.toHaveBeenCalled();
    expect(links.get(USER_ID)).toBeNull();
  });

  it('reports a device without HealthKit', async () => {
    const { deps, health, api } = setup();
    health.available = false;

    expect(await connectAppleHealth(deps, USER_ID)).toEqual({ kind: 'unavailable' });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('reports a failed consent check without linking', async () => {
    const { deps, links, api } = setup();
    api.get.mockRejectedValue(new NetworkError('offline'));

    expect(await connectAppleHealth(deps, USER_ID)).toEqual({
      kind: 'error',
      error: { key: 'errors.network', authRequired: false },
    });
    expect(links.get(USER_ID)).toBeNull();
  });

  it('keeps the existing link (and its anchor) when connecting again', async () => {
    const { deps, links } = setup();
    links.connect(USER_ID, 42);
    links.saveAnchor(USER_ID, '7');

    await connectAppleHealth(deps, USER_ID);

    expect(links.get(USER_ID)).toEqual({ sinceMs: 42, anchor: '7' });
  });
});

describe('importAppleHealthWorkouts', () => {
  it('does nothing before the user connected', async () => {
    const { deps, health } = setup();
    expect(await importAppleHealthWorkouts(deps, USER_ID)).toEqual({ kind: 'notConnected' });
    expect(health.queryWorkouts).not.toHaveBeenCalled();
  });

  it('stops when the thirdParty consent was withdrawn since connecting', async () => {
    const { deps, health, links, api } = setup({ consent: false });
    links.connect(USER_ID, 0);
    health.workouts = workouts(2);

    expect(await importAppleHealthWorkouts(deps, USER_ID)).toEqual({ kind: 'consentRequired' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('logs every new workout once, oldest first, with a key derived from its uuid', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = workouts(3).reverse();

    expect(await importAppleHealthWorkouts(deps, USER_ID)).toEqual({
      kind: 'done',
      imported: 3,
      queued: 0,
      skipped: 0,
    });

    const bodies = api.post.mock.calls.map(
      (call) => call[1] as { startedAt: string; source: { externalId: string } },
    );
    expect(bodies.map((b) => b.source.externalId)).toEqual(['HK-0000', 'HK-0001', 'HK-0002']);
    expect(api.post.mock.calls.every((call) => call[0] === '/v1/sessions')).toBe(true);
    expect(postedKeys(api.post)).toEqual(
      await Promise.all(
        ['HK-0000', 'HK-0001', 'HK-0002'].map((id) =>
          importIdempotencyKey(sha256, 'appleHealth', id),
        ),
      ),
    );
    expect(links.get(USER_ID)?.anchor).toBe('3');
  });

  it('only reads what was added since the stored anchor', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = workouts(2);
    await importAppleHealthWorkouts(deps, USER_ID);
    api.post.mockClear();

    health.workouts.push(...workouts(1, DAY_MS).map((w) => ({ ...w, uuid: 'HK-NEW' })));
    expect(await importAppleHealthWorkouts(deps, USER_ID)).toMatchObject({ imported: 1 });

    expect(health.queryWorkouts).toHaveBeenLastCalledWith(
      expect.objectContaining({ anchor: '2', since: new Date(0), limit: PAGE_SIZE }),
    );
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('reads page after page until a short page', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = workouts(PAGE_SIZE + 3);

    expect(await importAppleHealthWorkouts(deps, USER_ID)).toMatchObject({
      kind: 'done',
      imported: PAGE_SIZE + 3,
    });
    expect(health.queryWorkouts).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenCalledTimes(PAGE_SIZE + 3);
    expect(links.get(USER_ID)?.anchor).toBe(String(PAGE_SIZE + 3));
  });

  it('queues the workouts offline through the write path, with the same derived keys', async () => {
    const { deps, health, links, api, queue } = setup({ status: 'offline' });
    links.connect(USER_ID, 0);
    health.workouts = workouts(2);

    expect(await importAppleHealthWorkouts(deps, USER_ID)).toEqual({
      kind: 'done',
      imported: 0,
      queued: 2,
      skipped: 0,
    });
    expect(api.post).not.toHaveBeenCalled();
    const pending = queue.pendingFor(USER_ID);
    expect(pending.map((m) => m.kind)).toEqual([
      IMPORT_HEALTH_WORKOUT_KIND,
      IMPORT_HEALTH_WORKOUT_KIND,
    ]);
    expect(pending[0]?.idempotencyKey).toBe(
      await importIdempotencyKey(sha256, 'appleHealth', 'HK-0000'),
    );
  });

  it('sends the same key again when a workout is imported twice', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = workouts(1);
    await importAppleHealthWorkouts(deps, USER_ID);
    disconnectAppleHealth(links, USER_ID);
    links.connect(USER_ID, 0);
    await importAppleHealthWorkouts(deps, USER_ID);

    const [first, second] = postedKeys(api.post);
    expect(second).toBe(first);
  });

  it('skips a workout that is not a session', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = [
      workout({
        uuid: 'HK-EMPTY',
        duration: { unit: 's', quantity: 0 },
        startDate: new Date(0),
        endDate: new Date(0),
      }),
      ...workouts(1),
    ];

    expect(await importAppleHealthWorkouts(deps, USER_ID)).toEqual({
      kind: 'done',
      imported: 1,
      queued: 0,
      skipped: 1,
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(links.get(USER_ID)?.anchor).toBe('2');
  });

  it('stops on a 422 from an API that does not know the source yet, keeping the anchor', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = workouts(2);
    api.post.mockRejectedValue(
      new ApiError(422, { type: 'about:blank', title: 'Unprocessable Entity', status: 422 }),
    );

    expect(await importAppleHealthWorkouts(deps, USER_ID)).toEqual({
      kind: 'error',
      error: { key: 'errors.validation', authRequired: false },
      imported: 0,
      queued: 0,
      skipped: 0,
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(links.get(USER_ID)?.anchor).toBeNull();
  });

  it('stops on a server error and keeps the anchor so the page is read again', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = workouts(3);
    api.post.mockResolvedValueOnce({ id: 'session' }).mockRejectedValueOnce(new ApiError(503));

    const result = await importAppleHealthWorkouts(deps, USER_ID);

    expect(result).toEqual({
      kind: 'error',
      error: { key: 'errors.generic', authRequired: false },
      imported: 1,
      queued: 0,
      skipped: 0,
    });
    expect(links.get(USER_ID)?.anchor).toBeNull();
    expect(stoppedNotice(result)).toEqual({
      key: 'mobile.health.result.stopped',
      values: { imported: 1, queued: 0 },
      tone: 'info',
    });
  });

  it('reports a HealthKit read failure', async () => {
    const { deps, health, links } = setup();
    links.connect(USER_ID, 0);
    health.queryError = new Error('HealthKit');

    expect(await importAppleHealthWorkouts(deps, USER_ID)).toMatchObject({
      kind: 'error',
      error: { key: 'errors.generic' },
    });
  });

  it('rethrows when cancelled and sends nothing more', async () => {
    const { deps, health, links, api } = setup();
    links.connect(USER_ID, 0);
    health.workouts = workouts(3);
    const controller = new AbortController();
    api.post.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ id: 'session' });
    });

    await expect(importAppleHealthWorkouts(deps, USER_ID, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(links.get(USER_ID)?.anchor).toBeNull();
  });
});

describe('healthNotice', () => {
  it('summarises an import', () => {
    expect(healthNotice({ kind: 'done', imported: 0, queued: 0, skipped: 0 })).toEqual({
      key: 'mobile.health.result.none',
      tone: 'info',
    });
    expect(healthNotice({ kind: 'done', imported: 2, queued: 1, skipped: 0 })).toEqual({
      key: 'mobile.health.result.done',
      values: { imported: 2, queued: 1, skipped: 0 },
      tone: 'info',
    });
    expect(healthNotice({ kind: 'consentRequired' })?.tone).toBe('error');
    expect(healthNotice({ kind: 'connected' })).toBeNull();
  });
});
