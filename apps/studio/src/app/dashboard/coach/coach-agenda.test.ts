/**
 * The coach home and schedule keep the classes assigned to the signed-in
 * coach, lead with the class running now or the next one, and split the
 * day from the coming week.
 */
import { afterAll, describe, expect, it } from 'vitest';

import {
  agendaRange,
  classesOf,
  coachAgenda,
  scopeClasses,
  type AssignedClass,
} from './coach-agenda';

const previousTz = process.env['TZ'];
process.env['TZ'] = 'Europe/Paris';

afterAll(() => {
  if (previousTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = previousTz;
});

const ME = 'coach-me';
const OTHER = 'coach-other';

function cls(
  id: string,
  startsAt: string,
  coachId: string | null,
  durationMin = 60,
): AssignedClass {
  return { id, title: id, startsAt, durationMin, capacity: 12, remaining: 4, coachId };
}

// Tuesday 20 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-20T08:00:00.000Z');

const EARLY = cls('early', '2026-10-20T05:00:00.000Z', ME);
const LIVE = cls('live', '2026-10-20T07:30:00.000Z', ME);
const NOON = cls('noon', '2026-10-20T10:15:00.000Z', ME);
const THEIRS = cls('theirs', '2026-10-20T09:00:00.000Z', OTHER);
const OPEN = cls('open', '2026-10-20T09:30:00.000Z', null);
const TOMORROW = cls('tomorrow', '2026-10-21T16:00:00.000Z', ME);
const LATER = cls('later', '2026-10-30T16:00:00.000Z', ME);

describe('classesOf', () => {
  it('keeps the classes assigned to the coach, never unassigned or other coaches ones', () => {
    expect(classesOf([EARLY, THEIRS, OPEN, NOON], ME).map((c) => c.id)).toEqual(['early', 'noon']);
    expect(classesOf([OPEN], ME)).toEqual([]);
  });
});

describe('scopeClasses', () => {
  it('shows the coach own classes, or every class of the studio', () => {
    const all = [EARLY, THEIRS, OPEN];
    expect(scopeClasses(all, 'mine', ME).map((c) => c.id)).toEqual(['early']);
    expect(scopeClasses(all, 'all', ME)).toBe(all);
  });
});

describe('agendaRange', () => {
  it('starts at local midnight and covers today plus the coming week', () => {
    const { from, to } = agendaRange(NOW);
    expect(from.toISOString()).toBe('2026-10-19T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-10-27T23:00:00.000Z');
  });
});

describe('coachAgenda', () => {
  it('leads with the class running now and counts the minutes it has left', () => {
    const agenda = coachAgenda([NOON, LIVE, EARLY, THEIRS, TOMORROW], ME, NOW);
    expect(agenda.focus).toEqual({ kind: 'live', cls: LIVE, minutesLeft: 30 });
    expect(agenda.next).toBe(NOON);
  });

  it('counts down to the next class when none is running', () => {
    const agenda = coachAgenda([EARLY, NOON, THEIRS], ME, NOW);
    expect(agenda.focus).toEqual({ kind: 'next', cls: NOON, minutes: 135 });
  });

  it('looks past today for the next class', () => {
    const agenda = coachAgenda([EARLY, TOMORROW], ME, NOW);
    expect(agenda.focus).toEqual({ kind: 'next', cls: TOMORROW, minutes: 32 * 60 });
  });

  it('has no focus when nothing is assigned to the coach', () => {
    const agenda = coachAgenda([THEIRS, OPEN], ME, NOW);
    expect(agenda.focus).toEqual({ kind: 'none' });
    expect(agenda.today).toEqual([]);
    expect(agenda.upcoming).toEqual([]);
    expect(agenda.next).toBeNull();
  });

  it('lists today in order, done classes included, and the coming week apart', () => {
    const agenda = coachAgenda([NOON, TOMORROW, LATER, LIVE, EARLY, THEIRS], ME, NOW);
    expect(agenda.today.map((c) => c.id)).toEqual(['early', 'live', 'noon']);
    expect(agenda.upcoming.map((c) => c.id)).toEqual(['tomorrow']);
  });
});
