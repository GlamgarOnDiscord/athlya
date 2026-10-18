import type { ProgramRepo } from '../ports.js';
import type { ProgramDetail, ProgramSubscription } from '@athlya/shared/schemas/api';

export const STUDIO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const PROGRAM_ID = '0b000000-0000-4000-8000-000000000001';
export const USER_ID = '11111111-1111-4111-8111-111111111111';

export function makeProgram(overrides: Partial<ProgramDetail> = {}): ProgramDetail {
  const weeks = overrides.weeks ?? [{ weekNumber: 1, title: null, workouts: [] }];
  return {
    id: PROGRAM_ID,
    studioId: STUDIO_ID,
    title: 'Strength 101',
    description: null,
    status: 'published',
    version: 0,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    archivedAt: null,
    ...overrides,
    weeks,
    weekCount: weeks.length,
  };
}

export function makeSubscription(
  overrides: Partial<ProgramSubscription> = {},
): ProgramSubscription {
  return {
    id: '0c000000-0000-4000-8000-000000000001',
    programId: PROGRAM_ID,
    programTitle: 'Strength 101',
    programStatus: 'published',
    startsOn: '2026-10-12',
    createdAt: '2026-10-12T08:00:00.000Z',
    ...overrides,
  };
}

/** A repo whose every method fails unless the test overrides it. */
export function stubRepo(overrides: Partial<ProgramRepo> = {}): ProgramRepo {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  return {
    list: unexpected('list'),
    get: unexpected('get'),
    create: unexpected('create'),
    update: unexpected('update'),
    archive: unexpected('archive'),
    subscribe: unexpected('subscribe'),
    cancelSubscription: unexpected('cancelSubscription'),
    listSubscriptions: unexpected('listSubscriptions'),
    listActiveSchedules: unexpected('listActiveSchedules'),
    ...overrides,
  };
}
