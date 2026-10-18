import { describe, expect, it, vi } from 'vitest';

import {
  archiveProgram,
  createProgram,
  getTodayWorkouts,
  listMySubscriptions,
  listPrograms,
  subscribeToProgram,
  unsubscribeFromProgram,
  updateProgram,
} from '../service.js';

import {
  PROGRAM_ID,
  STUDIO_ID,
  USER_ID,
  makeProgram,
  makeSubscription,
  stubRepo,
} from './fixtures.js';

import type { ProgramViewer } from '../ports.js';
import type { CreateProgramRequest } from '@athlya/shared/schemas/api';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const now = () => NOW;

const admin: ProgramViewer = { userId: USER_ID, studioId: STUDIO_ID, role: 'admin' };
const coach: ProgramViewer = { ...admin, role: 'coach' };
const member: ProgramViewer = { ...admin, role: 'member' };

const createInput: CreateProgramRequest = {
  title: 'Strength 101',
  weeks: [{ weekNumber: 1, workouts: [{ dayNumber: 1, title: 'Squat', exercises: [] }] }],
};

describe('listPrograms', () => {
  it('lets staff list every status or filter by one', async () => {
    const list = vi.fn().mockResolvedValue([]);
    await listPrograms(admin, {}, { repo: stubRepo({ list }) });
    await listPrograms(coach, { status: 'draft' }, { repo: stubRepo({ list }) });
    expect(list).toHaveBeenNthCalledWith(1, {});
    expect(list).toHaveBeenNthCalledWith(2, { status: 'draft' });
  });

  it('restricts members to the published catalogue', async () => {
    const list = vi.fn().mockResolvedValue([]);
    await listPrograms(member, {}, { repo: stubRepo({ list }) });
    expect(list).toHaveBeenCalledWith({ status: 'published' });
    await expect(
      listPrograms(member, { status: 'draft' }, { repo: stubRepo({ list }) }),
    ).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('createProgram', () => {
  it('creates a draft in the admin studio, attributed to the admin', async () => {
    const program = makeProgram({ status: 'draft' });
    const create = vi.fn().mockResolvedValue(program);
    const outcome = await createProgram(admin, createInput, { repo: stubRepo({ create }) });
    expect(outcome).toEqual({ kind: 'created', program });
    expect(create).toHaveBeenCalledWith({
      studioId: STUDIO_ID,
      createdBy: USER_ID,
      title: 'Strength 101',
      description: null,
      status: 'draft',
      weeks: createInput.weeks,
    });
  });

  it('keeps an explicit published status', async () => {
    const create = vi.fn().mockResolvedValue(makeProgram());
    await createProgram(
      admin,
      { ...createInput, status: 'published' },
      {
        repo: stubRepo({ create }),
      },
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ status: 'published' }));
  });

  it.each([coach, member])('refuses a $role', async (viewer) => {
    const create = vi.fn();
    await expect(
      createProgram(viewer, createInput, { repo: stubRepo({ create }) }),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('updateProgram', () => {
  it('forwards only the patched fields with the expected version', async () => {
    const update = vi.fn().mockResolvedValue({ kind: 'conflict' });
    const outcome = await updateProgram(
      admin,
      PROGRAM_ID,
      { version: 3, description: null, status: 'published' },
      { repo: stubRepo({ update }) },
    );
    expect(outcome).toEqual({ kind: 'conflict' });
    expect(update).toHaveBeenCalledWith(PROGRAM_ID, 3, { description: null, status: 'published' });
  });

  it('refuses a coach', async () => {
    await expect(
      updateProgram(coach, PROGRAM_ID, { version: 0, title: 'x' }, { repo: stubRepo() }),
    ).resolves.toEqual({ kind: 'forbidden' });
  });
});

describe('archiveProgram', () => {
  it('archives a visible program and reports a missing one', async () => {
    const archived = makeProgram({ status: 'archived', archivedAt: '2026-10-18T10:00:00.000Z' });
    const archive = vi.fn().mockResolvedValueOnce(archived).mockResolvedValueOnce(null);
    const deps = { repo: stubRepo({ archive }) };
    await expect(archiveProgram(admin, PROGRAM_ID, deps)).resolves.toEqual({
      kind: 'archived',
      program: archived,
    });
    await expect(archiveProgram(admin, PROGRAM_ID, deps)).resolves.toEqual({ kind: 'not_found' });
  });

  it('refuses a member', async () => {
    await expect(archiveProgram(member, PROGRAM_ID, { repo: stubRepo() })).resolves.toEqual({
      kind: 'forbidden',
    });
  });
});

describe('subscribeToProgram', () => {
  it('subscribes the caller from today by default', async () => {
    const subscription = makeSubscription({ startsOn: '2026-10-18' });
    const get = vi.fn().mockResolvedValue(makeProgram());
    const subscribe = vi.fn().mockResolvedValue({ kind: 'subscribed', subscription });
    const outcome = await subscribeToProgram(
      member,
      PROGRAM_ID,
      {},
      {
        repo: stubRepo({ get, subscribe }),
        now,
      },
    );
    expect(outcome).toEqual({ kind: 'subscribed', subscription });
    expect(subscribe).toHaveBeenCalledWith({
      programId: PROGRAM_ID,
      studioId: STUDIO_ID,
      userId: USER_ID,
      startsOn: '2026-10-18',
    });
  });

  it('accepts a start date within the allowed window', async () => {
    const get = vi.fn().mockResolvedValue(makeProgram());
    const subscribe = vi
      .fn()
      .mockResolvedValue({ kind: 'subscribed', subscription: makeSubscription() });
    const deps = { repo: stubRepo({ get, subscribe }), now };
    await subscribeToProgram(member, PROGRAM_ID, { startsOn: '2026-09-20' }, deps);
    await subscribeToProgram(member, PROGRAM_ID, { startsOn: '2027-01-17' }, deps);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it.each(['2026-09-19', '2027-01-18'])(
    'rejects a start date out of window (%s)',
    async (startsOn) => {
      const get = vi.fn();
      await expect(
        subscribeToProgram(member, PROGRAM_ID, { startsOn }, { repo: stubRepo({ get }), now }),
      ).resolves.toEqual({ kind: 'invalid_start' });
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('reports an invisible program as not found', async () => {
    const get = vi.fn().mockResolvedValue(null);
    await expect(
      subscribeToProgram(member, PROGRAM_ID, {}, { repo: stubRepo({ get }), now }),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it.each(['draft', 'archived'] as const)('refuses a %s program', async (status) => {
    const get = vi.fn().mockResolvedValue(makeProgram({ status }));
    const subscribe = vi.fn();
    await expect(
      subscribeToProgram(admin, PROGRAM_ID, {}, { repo: stubRepo({ get, subscribe }), now }),
    ).resolves.toEqual({ kind: 'not_subscribable' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('passes an existing active subscription through', async () => {
    const subscription = makeSubscription();
    const get = vi.fn().mockResolvedValue(makeProgram());
    const subscribe = vi.fn().mockResolvedValue({ kind: 'already_subscribed', subscription });
    await expect(
      subscribeToProgram(member, PROGRAM_ID, {}, { repo: stubRepo({ get, subscribe }), now }),
    ).resolves.toEqual({ kind: 'already_subscribed', subscription });
  });
});

describe('unsubscribeFromProgram / listMySubscriptions', () => {
  it('cancels the caller own subscription only', async () => {
    const cancelSubscription = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deps = { repo: stubRepo({ cancelSubscription }) };
    await expect(unsubscribeFromProgram(member, PROGRAM_ID, deps)).resolves.toEqual({
      kind: 'unsubscribed',
    });
    await expect(unsubscribeFromProgram(member, PROGRAM_ID, deps)).resolves.toEqual({
      kind: 'not_found',
    });
    expect(cancelSubscription).toHaveBeenCalledWith(PROGRAM_ID, USER_ID);
  });

  it('lists the caller subscriptions', async () => {
    const items = [makeSubscription()];
    const listSubscriptions = vi.fn().mockResolvedValue(items);
    await expect(
      listMySubscriptions(member, { repo: stubRepo({ listSubscriptions }) }),
    ).resolves.toBe(items);
    expect(listSubscriptions).toHaveBeenCalledWith(USER_ID);
  });
});

describe('getTodayWorkouts', () => {
  const program = makeProgram({
    weeks: [
      {
        weekNumber: 1,
        title: null,
        workouts: [
          {
            id: '00000000-0000-4000-8000-0000000000a1',
            dayNumber: 7,
            title: 'Long run',
            notes: 'Easy pace',
            exercises: [{ name: 'Run', sets: 1, durationSec: 3600 }],
          },
        ],
      },
    ],
  });

  it('resolves every active subscription on the server date by default', async () => {
    const listActiveSchedules = vi.fn().mockResolvedValue([
      { subscription: makeSubscription({ startsOn: '2026-10-12' }), program },
      {
        subscription: makeSubscription({
          id: '0c000000-0000-4000-8000-000000000002',
          startsOn: '2026-10-25',
        }),
        program,
      },
    ]);
    const response = await getTodayWorkouts(member, undefined, {
      repo: stubRepo({ listActiveSchedules }),
      now,
    });
    expect(listActiveSchedules).toHaveBeenCalledWith(USER_ID);
    expect(response).toMatchObject({
      date: '2026-10-18',
      items: [
        { status: 'scheduled', weekNumber: 1, dayNumber: 7, workout: { title: 'Long run' } },
        { status: 'not_started', workout: null },
      ],
    });
  });

  it('uses the member local date when given', async () => {
    const listActiveSchedules = vi
      .fn()
      .mockResolvedValue([{ subscription: makeSubscription({ startsOn: '2026-10-12' }), program }]);
    await expect(
      getTodayWorkouts(member, '2026-10-19', { repo: stubRepo({ listActiveSchedules }), now }),
    ).resolves.toMatchObject({ date: '2026-10-19', items: [{ status: 'completed' }] });
  });

  it('refuses a date more than a year away', async () => {
    await expect(
      getTodayWorkouts(member, '2028-01-01', { repo: stubRepo(), now }),
    ).resolves.toEqual({ kind: 'invalid_date' });
  });

  it('returns an empty list without subscriptions', async () => {
    const listActiveSchedules = vi.fn().mockResolvedValue([]);
    await expect(
      getTodayWorkouts(member, undefined, { repo: stubRepo({ listActiveSchedules }), now }),
    ).resolves.toEqual({ date: '2026-10-18', items: [] });
  });
});
