/**
 * Members service — RGPD data-export use case.
 *
 * Implements task 5.3 of the Athlya implementation plan. The two use
 * cases exposed by this module are:
 *
 *   - {@link enqueueExport} — insert a row into the `export_jobs`
 *     table and publish a `members.export.requested` event on QStash
 *     so the background worker can start streaming (Requirement 4.1).
 *     If an active export already exists for the user (status
 *     `pending` or `running`), the existing job is reused — the API
 *     gateway therefore returns the same `jobId` on double-tap /
 *     retry, matching the idempotent-mutation posture we apply
 *     everywhere else (Requirement 20.1).
 *   - {@link runExportJob} — background worker entry point. Streams
 *     profile, consents, reservations, workout_sessions, check-ins
 *     and invoices into a single ZIP archive (JSON + CSV per
 *     collection), uploads the bytes to Cloudflare R2 and publishes
 *     `members.export.completed` with a signed URL valid 72 h
 *     (Requirements 4.2, 4.4). On any data-source failure the job is
 *     marked `failed` with a short human-readable reason; no
 *     completion event is published (Requirement 4.1 implies the
 *     user never sees a half-finished archive).
 *
 * Framework-free by design: the module depends only on the six
 * pluggable ports declared below. Concrete implementations of each
 * port (Drizzle repo, real Cloudflare R2 binding, QStash publisher,
 * fflate-backed archive builder) are assembled by the API gateway and
 * the worker Wrangler entry point.
 *
 * Returning a discriminated result instead of throwing keeps the
 * caller's control flow explicit: the gateway maps `'ok'` to HTTP 202
 * / 200, `'failed'` to HTTP 500 and the worker's retry logic can
 * inspect the error reason without `instanceof` across module
 * boundaries.
 */

import type {
    AthlyaEvent,
    MembersExportCompletedEvent,
    MembersExportRequestedEvent,
} from '@athlya/shared/events';
import type { Consents } from '@athlya/shared/schemas';
import type {
    AuditLog,
    Reservation,
    WorkoutSession,
} from '@athlya/shared/schemas/domain';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Signed-URL TTL for the completed archive, in seconds. Matches the
 * 72-hour window carved out by Requirement 4.2: `72 × 60 × 60 = 259_200`.
 * Exported for the unit tests so the assertion stays in sync with the
 * production value.
 */
export const DOWNLOAD_URL_TTL_SECONDS = 72 * 60 * 60;

/**
 * Prefix under which archives are stored in Cloudflare R2. The full
 * key is `EXPORT_R2_PREFIX/{jobId}.zip`; keeping the prefix as a
 * named constant makes it trivial to snapshot / rotate a bucket
 * without rebuilding service images.
 */
export const EXPORT_R2_PREFIX = 'exports/members';

/* ------------------------------------------------------------------ */
/*  Domain view types                                                  */
/* ------------------------------------------------------------------ */

/**
 * Member profile fields included in the export archive. Narrower than
 * the DB row: we intentionally omit `passwordHash`, internal soft-
 * delete markers and anything not required by Requirement 4.4.
 *
 * Declared here (rather than re-using `MemberProfile` from
 * `./service.ts`) so the export surface is self-contained and can
 * evolve without recompiling the profile service.
 */
export interface ExportProfile {
    id: string;
    studioId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    role: 'member' | 'coach' | 'admin';
    createdAt: string;
}

/**
 * Minimal shape of a check-in record included in the archive. The
 * production schema stores check-ins as timestamp columns on the
 * matching reservation row; this port exposes them as a dedicated
 * collection so downstream ZIP entries stay self-describing.
 */
export interface CheckinRecord {
    reservationId: string;
    classId: string;
    checkedInAt: string;
}

/**
 * Minimal shape of a billing invoice included in the archive. The
 * Billing_Service owns the canonical model; the exporter only needs a
 * handful of fields to honour Requirement 4.4 ("billing invoices
 * owned by the member") without leaking Stripe internals.
 */
export interface InvoiceRecord {
    id: string;
    issuedAt: string;
    amountCents: number;
    currency: string;
    description: string;
    pdfUrl: string | null;
}

/**
 * Bundle of data returned by the data source port. All collections
 * are eager (not async iterators) because the archive format (ZIP)
 * requires knowing the byte size of every entry up-front.
 */
export interface MemberExportData {
    profile: ExportProfile;
    consents: ReadonlyArray<Consents>;
    reservations: ReadonlyArray<Reservation>;
    sessions: ReadonlyArray<WorkoutSession>;
    checkins: ReadonlyArray<CheckinRecord>;
    invoices: ReadonlyArray<InvoiceRecord>;
    /**
     * Audit rows referencing the user. Optional — the exporter
     * includes it only when the data source exposes it. Some
     * deployments gate audit visibility behind an admin role even
     * for the subject; the unit tests cover both modes.
     */
    auditTrail?: ReadonlyArray<AuditLog>;
}

/**
 * One logical entry in the ZIP archive: a filename and its byte
 * payload. The concrete {@link ArchiveBuilder} is free to reorder or
 * compress entries however it sees fit.
 */
export interface ArchiveEntry {
    /** Relative path inside the archive, e.g. `profile.json`. */
    name: string;
    /** Raw bytes for the entry. */
    bytes: Uint8Array;
}

/**
 * Structured result returned by the archive builder. `sizeBytes` is
 * exposed so the worker can log / observe large archives without
 * re-measuring the Uint8Array.
 */
export interface ArchiveResult {
    bytes: Uint8Array;
    sizeBytes: number;
}

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Persistence port for `export_jobs` rows. The production
 * implementation wraps Drizzle inserts under `withTenant(claims, fn)`
 * so RLS is applied (Requirement 13).
 *
 * The port intentionally models state transitions as individual
 * methods rather than a generic `update(patch)` so the service layer
 * cannot accidentally skip the intermediate states — the audit trail
 * stored in `export_jobs` is only useful if every transition is
 * recorded.
 */
export interface ExportJobStore {
    /**
     * Insert a new `pending` row. Must throw on unique-violation so
     * the caller can decide whether to dedup.
     */
    create(jobId: string, userId: string, requestedAt: Date): Promise<void>;

    /**
     * Transition the row from `pending` → `running`. Idempotent: a
     * second call with the same `jobId` is a no-op.
     */
    markRunning(jobId: string, startedAt: Date): Promise<void>;

    /**
     * Transition the row from `running` → `completed`, stamping the
     * signed URL and its expiration. Idempotent.
     */
    markCompleted(
        jobId: string,
        completedAt: Date,
        downloadUrl: string,
        downloadExpiresAt: Date,
    ): Promise<void>;

    /**
     * Transition the row to `failed`, stamping a short human-readable
     * error reason. Idempotent.
     */
    markFailed(jobId: string, error: string): Promise<void>;

    /** Fetch a stored job, or `null` if unknown. */
    get(jobId: string): Promise<ExportJobRecord | null>;

    /**
     * Return the `id` of any active (pending / running) job for
     * `userId`, or `null` if none exists. Used by the dedup path in
     * {@link enqueueExport}.
     */
    findActiveByUser(userId: string): Promise<string | null>;
}

/** Shape of a stored job row as exposed to the service layer. */
export interface ExportJobRecord {
    id: string;
    userId: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
    downloadUrl: string | null;
    downloadExpiresAt: string | null;
}

/**
 * Read-only view of every personal data store that must land in the
 * archive (Requirement 4.4). Each method fetches one collection so
 * tests can stub them independently; the service calls them in
 * parallel for throughput.
 */
export interface MemberDataSource {
    fetchProfile(userId: string): Promise<ExportProfile>;
    fetchConsents(userId: string): Promise<ReadonlyArray<Consents>>;
    listReservations(userId: string): Promise<ReadonlyArray<Reservation>>;
    listSessions(userId: string): Promise<ReadonlyArray<WorkoutSession>>;
    listCheckins(userId: string): Promise<ReadonlyArray<CheckinRecord>>;
    listInvoices(userId: string): Promise<ReadonlyArray<InvoiceRecord>>;
    /** Optional — audit trail visible to the subject. */
    listAuditTrail?(userId: string): Promise<ReadonlyArray<AuditLog>>;
}

/**
 * Port that assembles {@link ArchiveEntry} items into a ZIP payload.
 * The production implementation uses `fflate`; test doubles return a
 * stub `Uint8Array` without actually compressing.
 */
export interface ArchiveBuilder {
    build(entries: ReadonlyArray<ArchiveEntry>): Promise<ArchiveResult>;
}

/**
 * Port for uploading the archive and issuing a signed download URL.
 * Separated from the archive builder because the R2 binding is a
 * different Cloudflare worker binding than anything else in the
 * module.
 */
export interface BlobStore {
    put(key: string, bytes: Uint8Array): Promise<void>;
    signedUrl(key: string, expiresSec: number): Promise<string>;
}

/**
 * Event publisher port. The QStash-backed concrete implementation
 * wraps the HTTP client exposed by `@upstash/qstash`; test doubles
 * record calls. No transaction handle is threaded through this port:
 * the `enqueueExport` path publishes directly (QStash is the
 * durability layer for scheduled jobs; the `export_jobs` row is the
 * transactional backing).
 */
export interface EventPublisher {
    publish(event: AthlyaEvent): Promise<void>;
}

/** Abstract clock so tests can freeze `now()`. */
export interface Clock {
    now(): number;
}

/** UUID v4/v7 generator so tests can inject deterministic ids. */
export type UuidFactory = () => string;

/* ------------------------------------------------------------------ */
/*  Deps / results                                                     */
/* ------------------------------------------------------------------ */

/** Dependencies injected into {@link enqueueExport}. */
export interface EnqueueExportDeps {
    jobs: ExportJobStore;
    events: EventPublisher;
    clock: Clock;
    uuid: UuidFactory;
}

/** Dependencies injected into {@link runExportJob}. */
export interface RunExportJobDeps {
    jobs: ExportJobStore;
    data: MemberDataSource;
    archive: ArchiveBuilder;
    blob: BlobStore;
    events: EventPublisher;
    clock: Clock;
    uuid: UuidFactory;
    logger?: {
        warn: (msg: string, extra?: Record<string, unknown>) => void;
        error: (msg: string, extra?: Record<string, unknown>) => void;
    };
}

/**
 * Discriminated result returned by {@link enqueueExport}. The caller
 * (API gateway) maps `ok` to HTTP 202 with `{ jobId }`; `deduped`
 * behaves identically but the gateway logs it for observability; no
 * other outcomes are surfaced — the data source is the only place
 * that can fail meaningfully, and enqueue never touches it.
 */
export type EnqueueExportResult =
    | { readonly kind: 'ok'; readonly jobId: string }
    | { readonly kind: 'deduped'; readonly jobId: string };

/**
 * Discriminated result returned by {@link runExportJob}. `completed`
 * is the happy path; `already_completed` covers retries hitting a
 * terminal row; `failed` stamps the job as failed and does NOT
 * publish the completion event; `not_found` protects against a
 * poisoned QStash message whose `jobId` was already hard-deleted.
 */
export type RunExportJobResult =
    | {
        readonly kind: 'completed';
        readonly downloadUrl: string;
        readonly expiresAt: string;
        readonly sizeBytes: number;
    }
    | { readonly kind: 'already_completed'; readonly jobId: string }
    | { readonly kind: 'failed'; readonly reason: string }
    | { readonly kind: 'not_found'; readonly jobId: string };

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** UTF-8 encoder reused across entries. */
const UTF8 = new TextEncoder();

/** Encode a JSON-serialisable value as pretty-printed UTF-8 bytes. */
function toJsonBytes(value: unknown): Uint8Array {
    return UTF8.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Minimal CSV encoder. Quotes every cell defensively so embedded
 * commas / quotes / newlines round-trip through spreadsheet tools
 * without escaping heuristics. Suitable for RGPD export where the
 * number of rows is bounded by a member's personal history.
 *
 * The columns argument is an ordered list of `(header, accessor)`
 * pairs; keeping the ordering explicit avoids the non-deterministic
 * iteration order that would result from `Object.keys`.
 */
function toCsvBytes<T>(
    rows: ReadonlyArray<T>,
    columns: ReadonlyArray<readonly [string, (row: T) => unknown]>,
): Uint8Array {
    const escape = (raw: unknown): string => {
        if (raw === null || raw === undefined) return '';
        const asString =
            typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '';
        // Always quote; escape embedded quotes by doubling them.
        return `"${asString.replace(/"/g, '""')}"`;
    };
    const lines: string[] = [];
    lines.push(columns.map(([header]) => escape(header)).join(','));
    for (const row of rows) {
        lines.push(columns.map(([, pick]) => escape(pick(row))).join(','));
    }
    // CSV consumers (Excel, LibreOffice) expect CRLF line endings.
    return UTF8.encode(`${lines.join('\r\n')}\r\n`);
}

/**
 * Build the list of archive entries from a populated
 * {@link MemberExportData} bundle. Profile and consents are JSON-only
 * (nested shapes don't flatten cleanly to CSV); every list-shaped
 * collection is emitted in both JSON and CSV form to match
 * Requirement 4.2 ("JSON and CSV").
 */
export function buildArchiveEntries(
    data: MemberExportData,
): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];

    entries.push({ name: 'profile.json', bytes: toJsonBytes(data.profile) });
    entries.push({ name: 'consents.json', bytes: toJsonBytes(data.consents) });

    entries.push({
        name: 'reservations.json',
        bytes: toJsonBytes(data.reservations),
    });
    entries.push({
        name: 'reservations.csv',
        bytes: toCsvBytes(data.reservations, [
            ['id', (r) => r.id],
            ['classId', (r) => r.classId],
            ['userId', (r) => r.userId],
            ['status', (r) => r.status],
            ['createdAt', (r) => r.createdAt],
            ['cancelledAt', (r) => r.cancelledAt],
            ['checkedInAt', (r) => r.checkedInAt],
        ]),
    });

    entries.push({
        name: 'workout_sessions.json',
        bytes: toJsonBytes(data.sessions),
    });
    entries.push({
        name: 'workout_sessions.csv',
        bytes: toCsvBytes(data.sessions, [
            ['id', (s) => s.id],
            ['userId', (s) => s.userId],
            ['studioId', (s) => s.studioId],
            ['startedAt', (s) => s.startedAt],
            ['durationMin', (s) => s.durationMin],
            ['exercisesJson', (s) => JSON.stringify(s.exercises)],
            ['notes', (s) => s.notes],
            ['createdAt', (s) => s.createdAt],
        ]),
    });

    entries.push({ name: 'checkins.json', bytes: toJsonBytes(data.checkins) });
    entries.push({
        name: 'checkins.csv',
        bytes: toCsvBytes(data.checkins, [
            ['reservationId', (c) => c.reservationId],
            ['classId', (c) => c.classId],
            ['checkedInAt', (c) => c.checkedInAt],
        ]),
    });

    entries.push({ name: 'invoices.json', bytes: toJsonBytes(data.invoices) });
    entries.push({
        name: 'invoices.csv',
        bytes: toCsvBytes(data.invoices, [
            ['id', (i) => i.id],
            ['issuedAt', (i) => i.issuedAt],
            ['amountCents', (i) => i.amountCents],
            ['currency', (i) => i.currency],
            ['description', (i) => i.description],
            ['pdfUrl', (i) => i.pdfUrl],
        ]),
    });

    if (data.auditTrail !== undefined) {
        entries.push({
            name: 'audit_trail.json',
            bytes: toJsonBytes(data.auditTrail),
        });
    }

    return entries;
}

/** Build the R2 object key for `jobId`. */
export function exportObjectKey(jobId: string): string {
    return `${EXPORT_R2_PREFIX}/${jobId}.zip`;
}

/**
 * Coerce an unknown caught value into a short, safe error reason that
 * can be stored in `export_jobs.error`. Trims to a bounded length so
 * a pathological stack trace never blows up the column.
 */
function toErrorReason(err: unknown, maxLen = 500): string {
    const raw =
        err instanceof Error
            ? `${err.name}: ${err.message}`
            : typeof err === 'string'
                ? err
                : JSON.stringify(err) ?? String(err);
    return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
}

/* ------------------------------------------------------------------ */
/*  enqueueExport                                                      */
/* ------------------------------------------------------------------ */

/**
 * Enqueue an RGPD export for `userId`.
 *
 * 1. If an active job already exists for the user, return its id
 *    (`kind: 'deduped'`). No new row is inserted and no event is
 *    republished — the worker is already scheduled.
 * 2. Otherwise, create a fresh `pending` row stamped with the
 *    current wall-clock time, publish the
 *    `members.export.requested` event on QStash and return the new
 *    id (`kind: 'ok'`).
 *
 * The dedup check is a soft guarantee: a race between two
 * concurrent enqueues can result in two active rows for the same
 * user. The price is at most one duplicate archive — the second
 * worker will simply produce the same bytes and the user never
 * sees a failure. Hardening beyond that (unique partial index) is
 * intentionally deferred until we see the collision in logs.
 *
 * Related requirements: 4.1 (async enqueue returning a job id),
 * 20.1 (idempotency posture for repeated mutation calls).
 */
export async function enqueueExport(
    userId: string,
    deps: EnqueueExportDeps,
): Promise<EnqueueExportResult> {
    // Dedup: reuse an active job if the user already has one in flight.
    const existingId = await deps.jobs.findActiveByUser(userId);
    if (existingId !== null) {
        return { kind: 'deduped', jobId: existingId };
    }

    const jobId = deps.uuid();
    const requestedAt = new Date(deps.clock.now());

    await deps.jobs.create(jobId, userId, requestedAt);

    const event: MembersExportRequestedEvent = {
        id: deps.uuid(),
        type: 'members.export.requested',
        occurredAt: requestedAt.toISOString(),
        payload: {
            userId: userId as MembersExportRequestedEvent['payload']['userId'],
            exportJobId: jobId,
        },
    };
    await deps.events.publish(event);

    return { kind: 'ok', jobId };
}

/* ------------------------------------------------------------------ */
/*  runExportJob                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run the background export job for `jobId`.
 *
 * The worker flow:
 *
 *   1. Load the row. If unknown → `not_found`; if already in a
 *      terminal state → `already_completed`.
 *   2. Transition to `running`.
 *   3. Fetch every required collection in parallel (Requirement
 *      4.4). Any failure here aborts — the job is marked `failed`
 *      with the thrown reason and no completion event is published
 *      (Requirement 4.1 implies the user never receives a half-
 *      finished archive).
 *   4. Build the ZIP archive via {@link ArchiveBuilder}, upload to
 *      Cloudflare R2 and issue a signed URL with a 72-hour TTL
 *      (Requirement 4.2).
 *   5. Mark the job `completed` and publish
 *      `members.export.completed`.
 *
 * The event's `occurredAt` and the row's `completedAt` are both
 * derived from a single `clock.now()` call so the audit trail and
 * the event payload cannot drift.
 */
export async function runExportJob(
    jobId: string,
    deps: RunExportJobDeps,
): Promise<RunExportJobResult> {
    const job = await deps.jobs.get(jobId);
    if (job === null) {
        return { kind: 'not_found', jobId };
    }
    if (job.status === 'completed' || job.status === 'failed') {
        return { kind: 'already_completed', jobId };
    }

    await deps.jobs.markRunning(jobId, new Date(deps.clock.now()));

    // Step 1: collect data. If any source throws, abort the job.
    let data: MemberExportData;
    try {
        const [
            profile,
            consents,
            reservations,
            sessions,
            checkins,
            invoices,
        ] = await Promise.all([
            deps.data.fetchProfile(job.userId),
            deps.data.fetchConsents(job.userId),
            deps.data.listReservations(job.userId),
            deps.data.listSessions(job.userId),
            deps.data.listCheckins(job.userId),
            deps.data.listInvoices(job.userId),
        ]);

        const auditTrail =
            deps.data.listAuditTrail !== undefined
                ? await deps.data.listAuditTrail(job.userId)
                : undefined;

        data = {
            profile,
            consents,
            reservations,
            sessions,
            checkins,
            invoices,
            ...(auditTrail === undefined ? {} : { auditTrail }),
        };
    } catch (err) {
        const reason = toErrorReason(err);
        await deps.jobs.markFailed(jobId, reason);
        deps.logger?.error('export job: data source failure', {
            jobId,
            userId: job.userId,
            error: reason,
        });
        return { kind: 'failed', reason };
    }

    // Step 2: build archive + upload + publish completion.
    try {
        const entries = buildArchiveEntries(data);
        const { bytes, sizeBytes } = await deps.archive.build(entries);

        const objectKey = exportObjectKey(jobId);
        await deps.blob.put(objectKey, bytes);
        const downloadUrl = await deps.blob.signedUrl(
            objectKey,
            DOWNLOAD_URL_TTL_SECONDS,
        );

        const completedAt = new Date(deps.clock.now());
        const expiresAt = new Date(
            completedAt.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000,
        );

        await deps.jobs.markCompleted(
            jobId,
            completedAt,
            downloadUrl,
            expiresAt,
        );

        const event: MembersExportCompletedEvent = {
            id: deps.uuid(),
            type: 'members.export.completed',
            occurredAt: completedAt.toISOString(),
            payload: {
                userId:
                    job.userId as MembersExportCompletedEvent['payload']['userId'],
                exportJobId: jobId,
                downloadUrl,
                expiresAt: expiresAt.toISOString(),
            },
        };
        await deps.events.publish(event);

        return {
            kind: 'completed',
            downloadUrl,
            expiresAt: expiresAt.toISOString(),
            sizeBytes,
        };
    } catch (err) {
        const reason = toErrorReason(err);
        await deps.jobs.markFailed(jobId, reason);
        deps.logger?.error('export job: archive / upload failure', {
            jobId,
            userId: job.userId,
            error: reason,
        });
        return { kind: 'failed', reason };
    }
}
