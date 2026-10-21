/**
 * Fictional data of the member demo (issue #750): one member of
 * "Studio Rive Gauche", two weeks of classes, a few bookings, a training
 * history and the AI coach quota. Every date is computed from `now` so
 * the demo always shows the current week.
 *
 * Loaded only by `./fake-api.ts`, itself loaded only in a demo build.
 */
import type {
  CardioProgressionResponse,
  Consents,
  ProgressionResponse,
} from '@athlya/shared/schemas';

export const DEMO_STUDIO_ID = '0f000000-0000-4000-8000-000000000001';

export interface DemoUser {
  readonly id: string;
  readonly studioId: string;
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly role: 'member' | 'coach' | 'admin';
  readonly consents: Consents;
  readonly createdAt: string;
  readonly deletedAt: null;
}

/** A class plus the seats taken by other members and its waitlist length. */
export interface DemoClass {
  readonly id: string;
  readonly studioId: string;
  readonly coachId: string | null;
  readonly title: string;
  readonly startsAt: string;
  readonly durationMin: number;
  readonly capacity: number;
  readonly version: number;
  readonly createdAt: string;
  readonly booked: number;
  readonly waitlisted: number;
}

export interface DemoReservation {
  readonly id: string;
  readonly classId: string;
  readonly userId: string;
  readonly status: 'confirmed' | 'waitlist' | 'cancelled';
  readonly position: number | null;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
  readonly checkedInAt: null;
}

export interface WebDemoState {
  readonly schema: 1;
  readonly signedIn: boolean;
  readonly member: DemoUser;
  readonly classes: readonly DemoClass[];
  readonly reservations: readonly DemoReservation[];
  readonly coachRemaining: number;
  readonly sequence: number;
}

export const COACH_DAILY_LIMIT = 10;

/** Deterministic UUID-shaped id: `prefix` picks the entity family. */
export function demoId(prefix: string, n: number): string {
  return `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function atLocal(now: Date, dayOffset: number, hours: number, minutes: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function utcDay(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function mondayWeeksAgo(now: Date, weeks: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * weeks);
  return d.toISOString().slice(0, 10);
}

type Slot = readonly [
  hours: number,
  minutes: number,
  title: string,
  durationMin: number,
  capacity: number,
];

const WEEKDAY_SLOTS: readonly Slot[] = [
  [7, 0, 'Pilates Reformer', 45, 12],
  [12, 15, 'Cross Training', 60, 16],
  [18, 30, 'Yoga Vinyasa', 60, 14],
  [19, 45, 'HIIT 45', 45, 20],
  [9, 30, 'Mobilité', 45, 12],
  [18, 0, 'Spinning', 45, 18],
  [19, 0, 'Boxe fitness', 60, 14],
  [7, 15, 'Barre au sol', 45, 12],
  [12, 30, 'Renfo full body', 60, 16],
];
const SATURDAY_SLOTS: readonly Slot[] = [
  [9, 30, 'Yoga Vinyasa', 60, 16],
  [11, 0, 'Mobilité', 45, 12],
];
const SUNDAY_SLOTS: readonly Slot[] = [[10, 0, 'Yin Yoga', 60, 14]];

function slotsFor(day: Date, index: number): readonly Slot[] {
  const dow = day.getDay();
  if (dow === 6) return SATURDAY_SLOTS;
  if (dow === 0) return SUNDAY_SLOTS;
  const start = index % WEEKDAY_SLOTS.length;
  const picked = [0, 3, 5, 7].map((k) => WEEKDAY_SLOTS[(start + k) % WEEKDAY_SLOTS.length]);
  return picked
    .filter((slot): slot is Slot => slot !== undefined)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function buildClasses(now: Date): DemoClass[] {
  const classes: DemoClass[] = [];
  for (let day = -1; day <= 13; day += 1) {
    const date = atLocal(now, day, 0, 0);
    slotsFor(date, day + 1).forEach(([h, m, title, durationMin, capacity], i) => {
      const n = classes.length + 1;
      const free = (n * 7 + i * 3) % 9;
      const full = n % 6 === 2;
      classes.push({
        id: demoId('0c', n),
        studioId: DEMO_STUDIO_ID,
        coachId: null,
        title,
        startsAt: atLocal(now, day, h, m).toISOString(),
        durationMin,
        capacity,
        version: 0,
        createdAt: '2026-09-01T08:00:00.000Z',
        booked: full ? capacity : Math.max(0, capacity - 1 - free),
        waitlisted: full ? 1 + (n % 3) : 0,
      });
    });
  }
  return classes;
}

export function createWebDemoState(now: Date): WebDemoState {
  const classes = buildClasses(now);
  const member: DemoUser = {
    id: demoId('0a', 9),
    studioId: DEMO_STUDIO_ID,
    email: 'lea.fontaine@example.com',
    displayName: 'Léa Fontaine',
    avatarUrl: null,
    role: 'member',
    consents: {
      marketing: false,
      analytics: true,
      thirdParty: true,
      version: '2026-01',
      updatedAt: '2026-10-02T09:30:00.000Z',
    },
    createdAt: '2026-09-26T09:15:00.000Z',
    deletedAt: null,
  };
  const upcoming = classes.filter((c) => Date.parse(c.startsAt) > now.getTime() + 3 * 3_600_000);
  const confirmed = [upcoming[1], upcoming[5], upcoming[11]].filter(
    (c): c is DemoClass => c !== undefined && c.booked < c.capacity,
  );
  const fullClass = upcoming.find((c) => c.booked >= c.capacity && !confirmed.includes(c));
  const reservations: DemoReservation[] = confirmed.map((c, i) => ({
    id: demoId('0e', i + 1),
    classId: c.id,
    userId: member.id,
    status: 'confirmed',
    position: null,
    createdAt: new Date(now.getTime() - (i + 2) * 86_400_000).toISOString(),
    cancelledAt: null,
    checkedInAt: null,
  }));
  if (fullClass !== undefined) {
    reservations.push({
      id: demoId('0e', reservations.length + 1),
      classId: fullClass.id,
      userId: member.id,
      status: 'waitlist',
      position: fullClass.waitlisted + 1,
      createdAt: new Date(now.getTime() - 86_400_000).toISOString(),
      cancelledAt: null,
      checkedInAt: null,
    });
  }
  return {
    schema: 1,
    signedIn: false,
    member,
    classes: classes.map((c) =>
      c.id === fullClass?.id ? { ...c, waitlisted: c.waitlisted + 1 } : c,
    ),
    reservations,
    coachRemaining: COACH_DAILY_LIMIT - 1,
    sequence: reservations.length + 1,
  };
}

const PROGRESSION_EXERCISES = [
  {
    name: 'Squat arrière',
    totalVolumeKg: 10240,
    points: [
      [63, 1180, 78],
      [49, 1320, 81],
      [35, 1400, 84],
      [28, 1460, 86],
      [14, 1580, 89],
      [7, 1620, 90],
      [2, 1680, 92],
    ],
  },
  {
    name: 'Développé couché',
    totalVolumeKg: 8400,
    points: [
      [60, 1020, 50],
      [46, 1100, 52],
      [32, 1180, 53],
      [25, 1200, 55],
      [11, 1260, 56],
      [4, 1300, 57],
      [1, 1340, 58],
    ],
  },
] as const;

export function demoProgression(now: Date, windowDays: 30 | 90 | 365): ProgressionResponse {
  const exercises = PROGRESSION_EXERCISES.map((exercise) => {
    const points = exercise.points
      .filter(([daysAgo]) => daysAgo < windowDays)
      .map(([daysAgo, volumeKg, estimatedOneRepMaxKg]) => ({
        date: utcDay(now, daysAgo),
        volumeKg,
        estimatedOneRepMaxKg,
      }));
    return {
      key: exercise.name.toLowerCase(),
      name: exercise.name,
      sessionCount: points.length,
      totalVolumeKg: points.reduce((sum, p) => sum + p.volumeKg, 0),
      bestEstimatedOneRepMaxKg: Math.max(...points.map((p) => p.estimatedOneRepMaxKg)),
      points,
    };
  }).filter((e) => e.sessionCount > 0);
  const weeks = [1, 2, 1, 2, 2, 1, 3, 2, 2, 1];
  return {
    windowDays,
    from: new Date(now.getTime() - windowDays * 86_400_000).toISOString(),
    to: now.toISOString(),
    totals: {
      sessions: exercises.reduce((sum, e) => sum + e.sessionCount, 0),
      volumeKg: exercises.reduce((sum, e) => sum + e.totalVolumeKg, 0),
    },
    exercises,
    weeklyFrequency: weeks.map((sessions, i) => ({
      weekStart: mondayWeeksAgo(now, weeks.length - 1 - i),
      sessions,
    })),
    truncated: false,
    skippedSessions: 0,
  };
}

export function demoCardio(now: Date, windowDays: 30 | 90 | 365): CardioProgressionResponse {
  const series = [5, 4, 3, 2, 1, 0].map((weeksAgo, i) => {
    const sessions = [1, 2, 1, 2, 2, 1][i] ?? 1;
    return {
      periodStart: mondayWeeksAgo(now, weeksAgo),
      sessions,
      durationSec: sessions * 1800,
      distanceM: sessions * 6200 + i * 150,
      energyKcal: sessions * 230,
      avgPowerW: 170 + i * 4,
      avgHeartRateBpm: 146 - i,
    };
  });
  const totals = series.reduce(
    (sum, s) => ({
      durationSec: sum.durationSec + s.durationSec,
      distanceM: sum.distanceM + s.distanceM,
      energyKcal: sum.energyKcal + s.energyKcal,
    }),
    { durationSec: 0, distanceM: 0, energyKcal: 0 },
  );
  const sessionCount = series.reduce((sum, s) => sum + s.sessions, 0);
  return {
    windowDays,
    from: new Date(now.getTime() - windowDays * 86_400_000).toISOString(),
    to: now.toISOString(),
    bucket: 'week',
    totals: { sessions: sessionCount, ...totals },
    machines: [
      {
        machine: 'rower',
        sessionCount,
        totals,
        series,
        points: series.map((s, i) => ({
          startedAt: `${s.periodStart}T07:30:00.000Z`,
          durationSec: 1800,
          distanceM: 6200 + i * 150,
          avgPowerW: s.avgPowerW,
          avgSpeedKmh: 12.4 + i * 0.2,
          avgHeartRateBpm: s.avgHeartRateBpm,
        })),
      },
    ],
    truncated: false,
    skippedSessions: 0,
  };
}

export const DEMO_COACH_ADVICE = {
  fr: {
    summary:
      'Votre volume au squat progresse régulièrement depuis deux mois. Gardez trois séances par semaine et ajoutez du travail de mobilité de hanche.',
    recommendations: [
      {
        title: 'Charge progressive',
        detail:
          'Ajoutez 2,5 kg au squat arrière quand vos trois séries de cinq passent sans échec.',
      },
      {
        title: 'Récupération',
        detail: 'Placez votre séance de Yin Yoga le lendemain des jours de jambes.',
      },
      {
        title: 'Cardio léger',
        detail:
          'Deux sorties de rameur de 20 minutes en zone 2 suffisent à soutenir la récupération.',
      },
    ],
    caution: null,
  },
  en: {
    summary:
      'Your squat volume has grown steadily for two months. Keep three sessions a week and add some hip mobility work.',
    recommendations: [
      {
        title: 'Progressive load',
        detail: 'Add 2.5 kg to the back squat once your three sets of five pass without a miss.',
      },
      {
        title: 'Recovery',
        detail: 'Book your Yin Yoga class the day after leg days.',
      },
      {
        title: 'Easy cardio',
        detail: 'Two 20-minute zone 2 rows are enough to support recovery.',
      },
    ],
    caution: null,
  },
} as const;
