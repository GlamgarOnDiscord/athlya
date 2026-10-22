/**
 * Fictional data of the studio demo (issue #750): "Studio Rive Gauche",
 * its admin Camille Durand, its manager Hugo Lefebvre, its front desk
 * Sarah Benali, its coaches Inès Garnier and Chloé Vasseur, nine members, a schedule from twelve weeks back to five weeks ahead
 * with full classes, programs and an audit trail. Every date is computed
 * from `now` so the demo always shows the current week.
 *
 * Loaded only by `./fake-api.ts`, itself loaded only in a demo build.
 */
import type { Role } from '@athlya/shared/roles';
import type { Consents } from '@athlya/shared/schemas';

export const DEMO_STUDIO_ID = '0f000000-0000-4000-8000-000000000001';

export interface DemoUser {
  readonly id: string;
  readonly studioId: string;
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly role: Role;
  readonly consents: Consents;
  readonly createdAt: string;
  readonly deletedAt: null;
}

/** A class plus the seats taken. */
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
}

export interface DemoStudio {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly brandColor: string;
  readonly brandLogo: string | null;
}

export interface DemoAuditEntry {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

export interface DemoProgramExercise {
  readonly name: string;
  readonly sets: number;
  readonly reps?: number;
  readonly restSec?: number;
}

export interface DemoProgramWorkout {
  readonly id: string;
  readonly dayNumber: number;
  readonly title: string;
  readonly notes: string | null;
  readonly exercises: readonly DemoProgramExercise[];
}

export interface DemoProgramWeek {
  readonly weekNumber: number;
  readonly title: string | null;
  readonly workouts: readonly DemoProgramWorkout[];
}

export interface DemoProgram {
  readonly id: string;
  readonly studioId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: 'draft' | 'published' | 'archived';
  readonly version: number;
  readonly weekCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly weeks: readonly DemoProgramWeek[];
}

export interface DemoCheckin {
  readonly token: string;
  readonly reservationId: string;
  readonly memberId: string;
  readonly at: string;
}

export interface StudioDemoState {
  readonly schema: 2;
  readonly sessionUserId: string | null;
  readonly studio: DemoStudio;
  readonly users: readonly DemoUser[];
  readonly classes: readonly DemoClass[];
  readonly audit: readonly DemoAuditEntry[];
  readonly programs: readonly DemoProgram[];
  readonly checkins: readonly DemoCheckin[];
  readonly sequence: number;
}

/** Deterministic UUID-shaped id: `prefix` picks the entity family. */
export function demoId(prefix: string, n: number): string {
  return `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const PEOPLE: readonly (readonly [string, Role])[] = [
  ['Camille Durand', 'admin'],
  ['Hugo Lefebvre', 'manager'],
  ['Inès Garnier', 'coach'],
  ['Lucas Bertin', 'member'],
  ['Manon Chevalier', 'member'],
  ['Nathan Roussel', 'member'],
  ['Chloé Vasseur', 'coach'],
  ['Théo Marchand', 'member'],
  ['Léa Fontaine', 'member'],
  ['Julien Moreau', 'member'],
  ['Sarah Benali', 'accueil'],
  ['Maxime Perrot', 'member'],
  ['Emma Lacroix', 'member'],
  ['Yanis Ferrand', 'member'],
];

function emailOf(name: string): string {
  const local = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/ /gu, '.');
  return `${local}@example.com`;
}

function buildUsers(): DemoUser[] {
  return PEOPLE.map(([displayName, role], i) => ({
    id: demoId('0a', i + 1),
    studioId: DEMO_STUDIO_ID,
    email: emailOf(displayName),
    displayName,
    avatarUrl: null,
    role,
    consents: {
      marketing: i % 3 === 0,
      analytics: i % 4 !== 1,
      thirdParty: i % 2 === 0,
      version: '2026-01',
      updatedAt: new Date(Date.UTC(2026, 8, 2 + i * 3, 9, 20)).toISOString(),
    },
    createdAt: new Date(Date.UTC(2026, 8, 2 + i * 3, 9, 15)).toISOString(),
    deletedAt: null,
  }));
}

export const DEMO_ADMIN_ID = demoId('0a', 1);
export const DEMO_MANAGER_ID = demoId('0a', 2);
export const DEMO_COACH_ID = demoId('0a', 3);
export const DEMO_ACCUEIL_ID = demoId('0a', 11);
const SECOND_COACH_ID = demoId('0a', 7);

const TITLES = [
  'Yoga Vinyasa',
  'Pilates Reformer',
  'HIIT 45',
  'Mobilité',
  'Cross Training',
  'Barre au sol',
  'Spinning',
  'Boxe fitness',
  'Yin Yoga',
  'Renfo full body',
];

type Slot = readonly [hours: number, minutes: number, durationMin: number, capacity: number];

const WEEKDAY_SLOTS: readonly Slot[] = [
  [7, 0, 45, 12],
  [12, 15, 60, 16],
  [18, 30, 60, 14],
  [19, 45, 45, 20],
];

/** Monday-based day of the week of `now`, then a local date in that week. */
function weekAt(now: Date, dayOffset: number, hours: number, minutes: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function coachFor(dayIndex: number, todayIndex: number, hours: number): string | null {
  if (hours === 7 || hours === 18 || (dayIndex === todayIndex && hours === 19))
    return DEMO_COACH_ID;
  if (dayIndex === 5 && hours === 9) return DEMO_COACH_ID;
  if (hours === 12) return SECOND_COACH_ID;
  return null;
}

function buildClasses(now: Date): DemoClass[] {
  const todayIndex = (now.getDay() + 6) % 7;
  const classes: DemoClass[] = [];
  for (let week = -12; week <= 5; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const slots: readonly Slot[] =
        day === 6
          ? [[10, 0, 60, 12]]
          : day === 5
            ? [
                [9, 30, 60, 16],
                [11, 0, 45, 12],
              ]
            : day === todayIndex
              ? WEEKDAY_SLOTS
              : WEEKDAY_SLOTS.slice(0, 2 + ((day + week + 7) % 3));
      for (const [h, m, durationMin, capacity] of slots) {
        const n = classes.length;
        const free = Math.min(capacity, Math.max(0, (((week + 20) * 3 + day * 5 + h) % 9) - 3));
        classes.push({
          id: demoId('0c', n + 1),
          studioId: DEMO_STUDIO_ID,
          coachId: coachFor(day, todayIndex, h),
          title: TITLES[n % TITLES.length] ?? 'Yoga Vinyasa',
          startsAt: weekAt(now, week * 7 + day, h, m).toISOString(),
          durationMin,
          capacity,
          version: 0,
          createdAt: '2026-09-01T08:00:00.000Z',
          booked: capacity - free,
        });
      }
    }
  }
  return classes;
}

const AUDIT_ACTIONS: readonly (readonly [string, string | null])[] = [
  ['reservation.cancelled_by_admin', 'reservation'],
  ['user.registered', 'user'],
  ['billing.webhook.processed', 'stripe_webhook'],
  ['user.consents.updated', 'user'],
  ['reservation.cancelled_by_admin', 'reservation'],
  ['token.refresh.reuse.detected', 'user'],
  ['dlq.entry.replayed', 'outbox'],
  ['user.registered', 'user'],
  ['billing.webhook.signature_failed', 'stripe_webhook'],
  ['user.consents.updated', 'user'],
  ['jwt.key.rotation_prep', null],
  ['user.registered', 'user'],
];

function buildAudit(now: Date, users: readonly DemoUser[]): DemoAuditEntry[] {
  return AUDIT_ACTIONS.map(([action, targetType], i) => {
    const system =
      action.startsWith('billing.') || action.startsWith('jwt.') || action.startsWith('dlq.');
    const actor = users[i % 2 === 0 ? 0 : (i + 3) % users.length];
    const target = users[(i + 2) % users.length];
    return {
      id: demoId('0d', i + 1),
      actorId: system ? null : (actor?.id ?? null),
      action,
      targetType,
      targetId:
        targetType === null
          ? null
          : targetType === 'user'
            ? (target?.id ?? null)
            : demoId('0e', i + 7),
      createdAt: new Date(now.getTime() - (i * 47 + 12) * 60_000).toISOString(),
    };
  });
}

function exercise(name: string, sets: number, reps: number, restSec: number): DemoProgramExercise {
  return { name, sets, reps, restSec };
}

function buildPrograms(): DemoProgram[] {
  const rows: readonly (readonly [string, string | null, 'draft' | 'published', number])[] = [
    [
      'Force fondamentale',
      'Quatre semaines pour poser les bases du squat, du soulevé de terre et du développé.',
      'published',
      4,
    ],
    [
      'Remise en forme 8 semaines',
      'Cardio et renforcement progressifs, trois séances par semaine.',
      'published',
      8,
    ],
    ['Mobilité du dos', null, 'draft', 2],
    ['Préparation trail', 'Endurance et gainage avant la saison.', 'draft', 6],
  ];
  return rows.map(([title, description, status, weekCount], i) => ({
    id: demoId('0b', i + 1),
    studioId: DEMO_STUDIO_ID,
    title,
    description,
    status,
    version: 0,
    weekCount,
    createdAt: `2026-09-${10 + i}T08:00:00.000Z`,
    updatedAt: `2026-10-${10 + i}T08:00:00.000Z`,
    archivedAt: null,
    weeks: [
      {
        weekNumber: 1,
        title: 'Prise en main',
        workouts: [
          {
            id: demoId('0b1', i * 10 + 1),
            dayNumber: 1,
            title: 'Bas du corps',
            notes: 'Échauffement 10 min avant.',
            exercises: [
              exercise('Squat', 4, 8, 120),
              exercise('Soulevé de terre roumain', 3, 10, 90),
            ],
          },
          {
            id: demoId('0b1', i * 10 + 2),
            dayNumber: 3,
            title: 'Haut du corps',
            notes: null,
            exercises: [
              exercise('Développé couché', 4, 8, 120),
              exercise('Rowing haltère', 3, 12, 60),
            ],
          },
        ],
      },
      {
        weekNumber: 2,
        title: null,
        workouts: [
          {
            id: demoId('0b1', i * 10 + 3),
            dayNumber: 2,
            title: 'Full body',
            notes: null,
            exercises: [exercise('Fentes marchées', 3, 12, 60)],
          },
        ],
      },
    ],
  }));
}

export function createStudioDemoState(now: Date): StudioDemoState {
  const users = buildUsers();
  return {
    schema: 2,
    sessionUserId: null,
    studio: {
      id: DEMO_STUDIO_ID,
      slug: 'studio-rive-gauche',
      name: 'Studio Rive Gauche',
      brandColor: '#0F766E',
      brandLogo: null,
    },
    users,
    classes: buildClasses(now),
    audit: buildAudit(now, users),
    programs: buildPrograms(),
    checkins: [],
    sequence: 1,
  };
}
