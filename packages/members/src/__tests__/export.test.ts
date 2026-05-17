/**
 * Unit tests for `@athlya/members/export`.
 *
 * Covers the two use cases added in task 5.3:
 *   - `enqueueExport`  — Requirement 4.1 (async enqueue returns a
 *     job id and publishes `members.export.requested`), plus the
 *     idempotent-retry posture (Requirement 20.1) which the service
 *     implements by reusing any active `pending` / `running` row.
 *   - `runExportJob`   — Requirements 4.2 (ZIP + signed URL with a
 *     72-hour TTL) and 4.4 (archive content covers profile, consents,
 *     reservations, workout_sessions, check-ins, invoices). Also
 *     verifies that a data-source failure marks the job as failed
 *     WITHOUT publishing the completion event.
 *
 * Every port is a hand-rolled `vi.fn()` double so the tests never
 * touch QStash, Cloudflare R2, Drizzle or a real Postgres. That
 * matches the style of `./service.test.ts` / `./sessions.test.ts`
 * and keeps the feedback loop tight.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  DOWNLOAD_URL_TTL_SECONDS,
  EXPORT_R2_PREFIX,
  buildArchiveEntries,
  enqueueExport,
  exportObjectKey,
  runExportJob,
  type ArchiveBuilder,
  type BlobStore,
  type CheckinRecord,
  type Clock,
  type EventPublisher,
  type ExportJobRecord,
  type ExportJobStore,
  type ExportProfile,
  type InvoiceRecord,
  type MemberDataSource,
  type UuidFactory,
} from '../export.js';

import type {
  AthlyaEvent,
  MembersExportCompletedEvent,
  MembersExportRequestedEvent,
} from '@athlya/shared/events';
import type { Consents } from '@athlya/shared/schemas';
import type { Reservation, WorkoutSession } from '@athlya/shared/schemas/domain';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const JOB_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ad';
const REQUEST_EVENT_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ae';
const COMPLETE_EVENT_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8af';

const FROZEN_REQUEST_TIME = Date.parse('2026-02-01T10:00:00.000Z');
const FROZEN_COMPLETE_TIME = Date.parse('2026-02-01T10:30:00.000Z');

const PROFILE: ExportProfile = {
  id: USER_ID,
  studioId: STUDIO_ID,
  email: 'member@example.test',
  displayName: 'Karim',
  avatarUrl: null,
  role: 'member',
  createdAt: '2025-01-01T00:00:00.000Z',
};

const CONSENTS_ROW: Consents = {
  marketing: true,
  analytics: false,
  thirdParty: false,
  version: '2026-01',
  updatedAt: '2026-01-15T12:00:00.000Z',
};

const RESERVATION_ROW = {
  id: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8b0',
  classId: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8b1',
  userId: USER_ID,
  status: 'confirmed',
  createdAt: '2026-01-10T08:00:00.000Z',
  cancelledAt: null,
  checkedInAt: null,
} as unknown as Reservation;

const SESSION_ROW = {
  id: '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8b2',
  userId: USER_ID,
  studioId: STUDIO_ID,
  startedAt: '2026-01-10T08:00:00.000Z',
  durationMin: 45,
  exercises: [{ name: 'Back squat', sets: [{ reps: 5, weightKg: 100 }] }],
  notes: null,
  createdAt: '2026-01-10T08:45:00.000Z',
} as unknown as WorkoutSession;

const CHECKIN_ROW: CheckinRecord = {
  reservationId: RESERVATION_ROW.id,
  classId: RESERVATION_ROW.classId,
  checkedInAt: '2026-01-10T07:55:00.000Z',
};

const INVOICE_ROW: InvoiceRecord = {
  id: 'in_123',
  issuedAt: '2026-01-01T00:00:00.000Z',
  amountCents: 4900,
  currency: 'EUR',
  description: 'Monthly subscription',
  pdfUrl: 'https://billing.example.test/invoices/in_123.pdf',
};

const STORED_JOB: ExportJobRecord = {
  id: JOB_ID,
  userId: USER_ID,
  status: 'pending',
  requestedAt: new Date(FROZEN_REQUEST_TIME).toISOString(),
  startedAt: null,
  completedAt: null,
  error: null,
  downloadUrl: null,
  downloadExpiresAt: null,
};

/* ------------------------------------------------------------------ */
/*  Builders                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hand-rolled `ExportJobStore` double. Declared as a helper rather
 * than inlined in each test so the individual cases stay focused on
 * the behaviour under test.
 */
function buildJobStore(): {
  jobs: ExportJobStore;
  create: Mock<ExportJobStore['create']>;
  markRunning: Mock<ExportJobStore['markRunning']>;
  markCompleted: Mock<ExportJobStore['markCompleted']>;
  markFailed: Mock<ExportJobStore['markFailed']>;
  get: Mock<ExportJobStore['get']>;
  findActiveByUser: Mock<ExportJobStore['findActiveByUser']>;
} {
  const create = vi.fn<ExportJobStore['create']>();
  const markRunning = vi.fn<ExportJobStore['markRunning']>();
  const markCompleted = vi.fn<ExportJobStore['markCompleted']>();
  const markFailed = vi.fn<ExportJobStore['markFailed']>();
  const get = vi.fn<ExportJobStore['get']>();
  const findActiveByUser = vi.fn<ExportJobStore['findActiveByUser']>();
  const jobs: ExportJobStore = {
    create,
    markRunning,
    markCompleted,
    markFailed,
    get,
    findActiveByUser,
  };
  return {
    jobs,
    create,
    markRunning,
    markCompleted,
    markFailed,
    get,
    findActiveByUser,
  };
}

function buildDataSource(): {
  data: MemberDataSource;
  fetchProfile: Mock<MemberDataSource['fetchProfile']>;
  fetchConsents: Mock<MemberDataSource['fetchConsents']>;
  listReservations: Mock<MemberDataSource['listReservations']>;
  listSessions: Mock<MemberDataSource['listSessions']>;
  listCheckins: Mock<MemberDataSource['listCheckins']>;
  listInvoices: Mock<MemberDataSource['listInvoices']>;
} {
  const fetchProfile = vi.fn<MemberDataSource['fetchProfile']>();
  const fetchConsents = vi.fn<MemberDataSource['fetchConsents']>();
  const listReservations = vi.fn<MemberDataSource['listReservations']>();
  const listSessions = vi.fn<MemberDataSource['listSessions']>();
  const listCheckins = vi.fn<MemberDataSource['listCheckins']>();
  const listInvoices = vi.fn<MemberDataSource['listInvoices']>();
  const data: MemberDataSource = {
    fetchProfile,
    fetchConsents,
    listReservations,
    listSessions,
    listCheckins,
    listInvoices,
  };
  return {
    data,
    fetchProfile,
    fetchConsents,
    listReservations,
    listSessions,
    listCheckins,
    listInvoices,
  };
}

function buildBlob(): {
  blob: BlobStore;
  put: Mock<BlobStore['put']>;
  signedUrl: Mock<BlobStore['signedUrl']>;
} {
  const put = vi.fn<BlobStore['put']>();
  const signedUrl = vi.fn<BlobStore['signedUrl']>();
  const blob: BlobStore = { put, signedUrl };
  return { blob, put, signedUrl };
}

function buildArchiveDouble(
  bytes = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]),
): { archive: ArchiveBuilder; build: Mock<ArchiveBuilder['build']> } {
  const build = vi.fn<ArchiveBuilder['build']>();
  build.mockResolvedValue({ bytes, sizeBytes: bytes.byteLength });
  const archive: ArchiveBuilder = { build };
  return { archive, build };
}

function buildEvents(): {
  events: EventPublisher;
  publish: Mock<EventPublisher['publish']>;
} {
  const publish = vi.fn<EventPublisher['publish']>();
  const events: EventPublisher = { publish };
  return { events, publish };
}

/**
 * Fake clock: returns the times in the order they were queued. Each
 * call advances to the next value, reusing the last one after the
 * queue is drained (so `runExportJob`'s multiple `now()` calls don't
 * trip over an empty queue).
 */
function buildClock(times: number[]): Clock {
  const queue = [...times];
  return {
    now(): number {
      if (queue.length === 1) return queue[0]!;
      return queue.shift()!;
    },
  };
}

/**
 * Deterministic UUID factory returning pre-seeded values in order.
 * Useful so tests can assert the exact `eventId` / `jobId` wired into
 * the published events.
 */
function buildUuid(...values: string[]): UuidFactory {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('buildUuid: queue exhausted');
    }
    return next;
  };
}

/* ------------------------------------------------------------------ */
/*  enqueueExport                                                      */
/* ------------------------------------------------------------------ */

describe('enqueueExport', () => {
  it('creates a pending job row and publishes members.export.requested', async () => {
    const store = buildJobStore();
    const { events, publish } = buildEvents();
    store.findActiveByUser.mockResolvedValueOnce(null);
    store.create.mockResolvedValueOnce(undefined);
    publish.mockResolvedValue(undefined);

    const result = await enqueueExport(USER_ID, {
      jobs: store.jobs,
      events,
      clock: buildClock([FROZEN_REQUEST_TIME]),
      uuid: buildUuid(JOB_ID, REQUEST_EVENT_ID),
    });

    expect(result).toEqual({ kind: 'ok', jobId: JOB_ID });

    // Persistence side-effect.
    expect(store.create).toHaveBeenCalledTimes(1);
    const createArgs = store.create.mock.calls[0]!;
    expect(createArgs[0]).toBe(JOB_ID);
    expect(createArgs[1]).toBe(USER_ID);
    expect(createArgs[2]).toBeInstanceOf(Date);
    expect(createArgs[2].toISOString()).toBe(new Date(FROZEN_REQUEST_TIME).toISOString());

    // Event side-effect.
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0] as MembersExportRequestedEvent;
    expect(event.type).toBe('members.export.requested');
    expect(event.id).toBe(REQUEST_EVENT_ID);
    expect(event.occurredAt).toBe(new Date(FROZEN_REQUEST_TIME).toISOString());
    expect(event.payload).toEqual({
      userId: USER_ID,
      exportJobId: JOB_ID,
    });
  });

  it('reuses an active job when the user already has one in flight (dedup)', async () => {
    const existingJobId = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c900';
    const store = buildJobStore();
    const { events, publish } = buildEvents();
    store.findActiveByUser.mockResolvedValueOnce(existingJobId);

    const result = await enqueueExport(USER_ID, {
      jobs: store.jobs,
      events,
      clock: buildClock([FROZEN_REQUEST_TIME]),
      // The UUID factory must NOT be called on the dedup path.
      uuid: () => {
        throw new Error('uuid should not be called on dedup');
      },
    });

    expect(result).toEqual({ kind: 'deduped', jobId: existingJobId });
    expect(store.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  runExportJob — happy path                                          */
/* ------------------------------------------------------------------ */

describe('runExportJob', () => {
  it('streams every data source, builds the archive, uploads it and publishes completion with TTL=259200', async () => {
    const store = buildJobStore();
    const source = buildDataSource();
    const { blob, put, signedUrl } = buildBlob();
    const { archive, build } = buildArchiveDouble();
    const { events, publish } = buildEvents();

    store.get.mockResolvedValueOnce(STORED_JOB);
    store.markRunning.mockResolvedValueOnce(undefined);
    store.markCompleted.mockResolvedValueOnce(undefined);

    source.fetchProfile.mockResolvedValueOnce(PROFILE);
    source.fetchConsents.mockResolvedValueOnce([CONSENTS_ROW]);
    source.listReservations.mockResolvedValueOnce([RESERVATION_ROW]);
    source.listSessions.mockResolvedValueOnce([SESSION_ROW]);
    source.listCheckins.mockResolvedValueOnce([CHECKIN_ROW]);
    source.listInvoices.mockResolvedValueOnce([INVOICE_ROW]);

    put.mockResolvedValueOnce(undefined);
    const signedUrlStr =
      'https://r2.example.test/exports/members/018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ad.zip?signed=abc';
    signedUrl.mockResolvedValueOnce(signedUrlStr);
    publish.mockResolvedValue(undefined);

    const result = await runExportJob(JOB_ID, {
      jobs: store.jobs,
      data: source.data,
      archive,
      blob,
      events,
      clock: buildClock([
        FROZEN_REQUEST_TIME + 60_000, // markRunning
        FROZEN_COMPLETE_TIME, // completedAt
      ]),
      uuid: buildUuid(COMPLETE_EVENT_ID),
    });

    // Result.
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.downloadUrl).toBe(signedUrlStr);
      expect(result.expiresAt).toBe(
        new Date(FROZEN_COMPLETE_TIME + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      );
      expect(result.sizeBytes).toBeGreaterThan(0);
    }

    // Data sources were fetched.
    expect(source.fetchProfile).toHaveBeenCalledWith(USER_ID);
    expect(source.fetchConsents).toHaveBeenCalledWith(USER_ID);
    expect(source.listReservations).toHaveBeenCalledWith(USER_ID);
    expect(source.listSessions).toHaveBeenCalledWith(USER_ID);
    expect(source.listCheckins).toHaveBeenCalledWith(USER_ID);
    expect(source.listInvoices).toHaveBeenCalledWith(USER_ID);

    // Archive was built with entries covering every collection.
    expect(build).toHaveBeenCalledTimes(1);
    const entries = build.mock.calls[0]![0];
    const names = entries.map((e) => e.name);
    expect(names).toContain('profile.json');
    expect(names).toContain('consents.json');
    expect(names).toContain('reservations.json');
    expect(names).toContain('reservations.csv');
    expect(names).toContain('workout_sessions.json');
    expect(names).toContain('workout_sessions.csv');
    expect(names).toContain('checkins.json');
    expect(names).toContain('checkins.csv');
    expect(names).toContain('invoices.json');
    expect(names).toContain('invoices.csv');

    // Upload to R2 used the expected key.
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(exportObjectKey(JOB_ID));

    // Signed URL TTL is exactly 72 h (Requirement 4.2).
    expect(signedUrl).toHaveBeenCalledTimes(1);
    expect(signedUrl).toHaveBeenCalledWith(exportObjectKey(JOB_ID), DOWNLOAD_URL_TTL_SECONDS);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(259_200);

    // Job row stamped with completedAt + url + expires.
    expect(store.markCompleted).toHaveBeenCalledTimes(1);
    const completeArgs = store.markCompleted.mock.calls[0]!;
    expect(completeArgs[0]).toBe(JOB_ID);
    expect(completeArgs[1].toISOString()).toBe(new Date(FROZEN_COMPLETE_TIME).toISOString());
    expect(completeArgs[2]).toBe(signedUrlStr);
    expect(completeArgs[3].toISOString()).toBe(
      new Date(FROZEN_COMPLETE_TIME + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    );

    // Completion event was published with the URL + expiresAt.
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]![0] as MembersExportCompletedEvent;
    expect(event.type).toBe('members.export.completed');
    expect(event.id).toBe(COMPLETE_EVENT_ID);
    expect(event.payload).toEqual({
      userId: USER_ID,
      exportJobId: JOB_ID,
      downloadUrl: signedUrlStr,
      expiresAt: new Date(FROZEN_COMPLETE_TIME + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    });

    // Job was never marked as failed.
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  /* -------------------------------------------------------------- */
  /*  Failure modes                                                  */
  /* -------------------------------------------------------------- */

  it('marks the job as failed when a data source throws and does NOT publish completion', async () => {
    const store = buildJobStore();
    const source = buildDataSource();
    const { blob } = buildBlob();
    const { archive, build } = buildArchiveDouble();
    const { events, publish } = buildEvents();

    store.get.mockResolvedValueOnce(STORED_JOB);
    store.markRunning.mockResolvedValueOnce(undefined);
    store.markFailed.mockResolvedValueOnce(undefined);

    source.fetchProfile.mockResolvedValueOnce(PROFILE);
    source.fetchConsents.mockRejectedValueOnce(new Error('consents repo offline'));
    source.listReservations.mockResolvedValueOnce([]);
    source.listSessions.mockResolvedValueOnce([]);
    source.listCheckins.mockResolvedValueOnce([]);
    source.listInvoices.mockResolvedValueOnce([]);

    const result = await runExportJob(JOB_ID, {
      jobs: store.jobs,
      data: source.data,
      archive,
      blob,
      events,
      clock: buildClock([FROZEN_REQUEST_TIME + 1000, FROZEN_COMPLETE_TIME]),
      uuid: buildUuid(COMPLETE_EVENT_ID),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toContain('consents repo offline');
    }
    expect(store.markFailed).toHaveBeenCalledTimes(1);
    const [failedJobId, reason] = store.markFailed.mock.calls[0]!;
    expect(failedJobId).toBe(JOB_ID);
    expect(reason).toContain('consents repo offline');

    // Critical invariant: completion was NOT published, and the
    // archive builder was never invoked.
    expect(publish).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(store.markCompleted).not.toHaveBeenCalled();
  });

  it('returns not_found when the job row is missing', async () => {
    const store = buildJobStore();
    const source = buildDataSource();
    const { blob } = buildBlob();
    const { archive } = buildArchiveDouble();
    const { events, publish } = buildEvents();

    store.get.mockResolvedValueOnce(null);

    const result = await runExportJob(JOB_ID, {
      jobs: store.jobs,
      data: source.data,
      archive,
      blob,
      events,
      clock: buildClock([FROZEN_REQUEST_TIME]),
      uuid: buildUuid(COMPLETE_EVENT_ID),
    });

    expect(result).toEqual({ kind: 'not_found', jobId: JOB_ID });
    expect(store.markRunning).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(store.markCompleted).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns already_completed for a terminal job (idempotent retry)', async () => {
    const store = buildJobStore();
    const source = buildDataSource();
    const { blob } = buildBlob();
    const { archive, build } = buildArchiveDouble();
    const { events, publish } = buildEvents();

    store.get.mockResolvedValueOnce({
      ...STORED_JOB,
      status: 'completed',
      completedAt: new Date(FROZEN_COMPLETE_TIME).toISOString(),
      downloadUrl: 'https://r2.example.test/stale.zip',
      downloadExpiresAt: new Date(
        FROZEN_COMPLETE_TIME + DOWNLOAD_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    });

    const result = await runExportJob(JOB_ID, {
      jobs: store.jobs,
      data: source.data,
      archive,
      blob,
      events,
      clock: buildClock([FROZEN_REQUEST_TIME]),
      uuid: buildUuid(COMPLETE_EVENT_ID),
    });

    expect(result).toEqual({ kind: 'already_completed', jobId: JOB_ID });
    expect(store.markRunning).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Archive entry shape                                                */
/* ------------------------------------------------------------------ */

describe('buildArchiveEntries', () => {
  it('emits JSON + CSV pairs for each listed collection and JSON-only for profile/consents', () => {
    const entries = buildArchiveEntries({
      profile: PROFILE,
      consents: [CONSENTS_ROW],
      reservations: [RESERVATION_ROW],
      sessions: [SESSION_ROW],
      checkins: [CHECKIN_ROW],
      invoices: [INVOICE_ROW],
    });
    const names = entries.map((e) => e.name);

    // JSON-only.
    expect(names).toContain('profile.json');
    expect(names).toContain('consents.json');
    // JSON + CSV.
    expect(names).toContain('reservations.json');
    expect(names).toContain('reservations.csv');
    expect(names).toContain('workout_sessions.json');
    expect(names).toContain('workout_sessions.csv');
    expect(names).toContain('checkins.json');
    expect(names).toContain('checkins.csv');
    expect(names).toContain('invoices.json');
    expect(names).toContain('invoices.csv');

    // Every entry has non-empty bytes.
    for (const entry of entries) {
      expect(entry.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it('produces valid JSON for the profile entry', () => {
    const entries = buildArchiveEntries({
      profile: PROFILE,
      consents: [],
      reservations: [],
      sessions: [],
      checkins: [],
      invoices: [],
    });
    const profileEntry = entries.find((e) => e.name === 'profile.json')!;
    const text = new TextDecoder().decode(profileEntry.bytes);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual(PROFILE);
  });
});

/* ------------------------------------------------------------------ */
/*  exportObjectKey                                                    */
/* ------------------------------------------------------------------ */

describe('exportObjectKey', () => {
  it('namespaces keys under the shared prefix', () => {
    expect(exportObjectKey(JOB_ID)).toBe(`${EXPORT_R2_PREFIX}/${JOB_ID}.zip`);
  });
});

/* ------------------------------------------------------------------ */
/*  Type-level assertion: published events satisfy AthlyaEvent         */
/* ------------------------------------------------------------------ */

// Compile-time check only — a regression swapping the event typing
// would fail to compile here. Wrapped in a function so the type
// assertions do not execute at runtime (declare-only bindings are
// erased to undefined references after esbuild strips the types).
function _typeCheckEvents(
  requested: MembersExportRequestedEvent,
  completed: MembersExportCompletedEvent,
): AthlyaEvent[] {
  return [requested, completed];
}
void _typeCheckEvents;
