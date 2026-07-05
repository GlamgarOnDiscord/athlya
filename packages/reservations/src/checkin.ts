/**
 * QR check-in use case for `@athlya/reservations`.
 *
 * Task 6.7 of the Athlya implementation plan. Wires Requirement 11 into
 * a framework-free service function:
 *
 *   - 11.1 — the mobile app mints the QR token; this service only
 *     consumes it.
 *   - 11.2, 11.3 — verification of signature, `kind`, `studio` and
 *     time window runs *before* any database read. Concrete signature
 *     validation lives in `@athlya/auth/qr`; this module calls it
 *     through the {@link QRVerifier} port so unit tests can stub it
 *     without importing `jose` or `@upstash/redis`.
 *   - 11.4, 11.5 — replay protection is owned by the verifier (`jti`
 *     stored in Redis with TTL = remaining token lifetime). A replay
 *     hit surfaces here as the literal reason code `'replay'`.
 *   - 11.6 — on success, locate the user's `confirmed` reservation
 *     whose class `starts_at ∈ [now − 30 min, now + 30 min]` and set
 *     `checked_in_at = now()`.
 *
 * The module is deliberately a *pure* function over injected ports.
 * It never throws on expected business failures — instead it returns a
 * discriminated {@link CheckInResult} union. The API gateway maps each
 * `code` to its HTTP status + Problem Details envelope (Requirement
 * 14.6); that mapping is not this module's concern.
 *
 * ### Why a non-throwing contract?
 *
 * Throwing `InvalidQRTokenError` / `QRReplayError` across the service
 * boundary would force the gateway to do `instanceof` checks on every
 * call and would lose the fine-grained reason codes listed in the
 * task description (`invalid_signature`, `token_expired`, `replay`,
 * `wrong_studio`, `wrong_kind`, `malformed`). Modelling the failure
 * modes as data instead lets the gateway branch on a single
 * `result.code` property and surface the exact reason to the client
 * without a second round of error reshaping.
 */

import type { ReservationRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Time-window constants                                              */
/* ------------------------------------------------------------------ */

/**
 * One minute in milliseconds. Extracted so the 30-minute window below
 * stays self-documenting without a magic `60_000`.
 */
const MINUTE_MS = 60_000;

/**
 * Half-width of the check-in window in milliseconds. Requirement 11.6:
 * `[now − 30 min, now + 30 min]`. Exported so route handlers and
 * integration tests can reuse the exact same value when building
 * their own fixtures.
 */
export const CHECKIN_WINDOW_HALF_MS = 30 * MINUTE_MS;

/* ------------------------------------------------------------------ */
/*  QR verifier port                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fine-grained failure reasons the QR verifier can surface. Each
 * reason is propagated verbatim through {@link CheckInResult.code} so
 * the API gateway can reflect it in the Problem Details envelope
 * without any translation.
 *
 *   - `invalid_signature` — RS256 signature verification failed.
 *   - `token_expired`     — `exp` is in the past (or `iat` in the
 *     future with `clockTolerance = 0`).
 *   - `replay`            — `jti` already consumed within TTL
 *     (Requirement 11.5).
 *   - `wrong_studio`      — `studio` claim mismatches the terminal's
 *     studio id.
 *   - `wrong_kind`        — `kind` claim is not `'checkin'` (e.g. an
 *     access token was presented as a QR).
 *   - `malformed`         — payload missing required claims or not a
 *     parseable compact JWS at all.
 *
 * Requirement 11.3 maps all of these to HTTP 401 at the API layer;
 * the broader set here is carried through as a richer diagnostic
 * (see `type` / `detail` in the Problem Details payload) so clients
 * can show actionable UI.
 */
export type QRVerifyFailReason =
  'invalid_signature' | 'token_expired' | 'replay' | 'wrong_studio' | 'wrong_kind' | 'malformed';

/**
 * Success envelope returned by the verifier. Matches the three pieces
 * of information the check-in flow cares about:
 *
 *   - `userId`    — becomes the filter for the reservation lookup.
 *   - `studioId`  — echoed back for sanity (should equal
 *     `expectedStudioId`).
 *   - `jti`       — retained for audit / tracing.
 */
export interface QRVerifySuccess {
  readonly ok: true;
  readonly userId: string;
  readonly studioId: string;
  readonly jti: string;
}

/**
 * Failure envelope returned by the verifier. The `reason` field is
 * the canonical machine-readable code.
 */
export interface QRVerifyFailure {
  readonly ok: false;
  readonly reason: QRVerifyFailReason;
}

/**
 * Discriminated union returned by {@link QRVerifier.verify}. Using
 * `{ ok: boolean }` as the tag keeps the consumer's narrowing short
 * and mirrors the shape used in `design.md` §"Exemple 4 —
 * Génération et vérification d'un QR check-in".
 */
export type QRVerifyResult = QRVerifySuccess | QRVerifyFailure;

/**
 * Abstract port the check-in service uses to consume a QR token.
 *
 * Production wires this to `@athlya/auth/qr`'s `verifyAccessQR`
 * (which throws `InvalidQRTokenError` / `QRReplayError`) through a
 * thin adapter that catches those exceptions and maps them to
 * {@link QRVerifyFailure} values — typically at the API gateway
 * boundary where `jwks` + `replayStore` are already available.
 *
 * Unit tests stub this port directly with `vi.fn()` so they never
 * need to import `jose` or stand up a Redis fake.
 */
export interface QRVerifier {
  verify(token: string, expectedStudioId: string): Promise<QRVerifyResult>;
}

/* ------------------------------------------------------------------ */
/*  Repository port                                                    */
/* ------------------------------------------------------------------ */

/**
 * Projection the repo returns alongside a candidate reservation.
 *
 * The service needs `classStartsAt` to decide between `outside_window`
 * and `ok`, so the repo's query is expected to `JOIN classes ON
 * reservations.class_id = classes.id` and project both columns in a
 * single round-trip. Keeping the join on the repo side avoids a
 * second SQL round-trip (`SELECT starts_at FROM classes WHERE id = $1`)
 * that would sit on the reservation-POST p99 budget (Requirement 23.2).
 */
export interface CheckinCandidate {
  /** The full reservation row — carries `checkedInAt` for step 5. */
  readonly reservation: ReservationRow;
  /** `classes.starts_at` of the class the reservation points at. */
  readonly classStartsAt: Date;
}

/**
 * Minimal persistence contract the check-in use case needs.
 *
 * Declared here (not in `@athlya/db`) so the service owns its own
 * port and so unit tests can provide a trivial `vi.fn()` double
 * without pulling Drizzle, Postgres or any network adapter into the
 * test runtime. The concrete Drizzle-backed implementation is wired
 * by the API gateway under `withTenant(claims, fn)` so RLS
 * (Requirement 13) is enforced transparently.
 */
export interface CheckinReservationRepo {
  /**
   * Find the candidate reservation for a QR check-in.
   *
   * Contract:
   *   - Return a non-`null` {@link CheckinCandidate} if and only if
   *     `(userId, studioId)` has exactly one `confirmed` reservation
   *     whose class `starts_at` is plausibly near `now`. The
   *     implementation SHOULD search a slightly broader range than
   *     the strict 30-minute window so the *service* can distinguish
   *     `outside_window` (a reservation that exists but is too far
   *     in the future) from `no_reservation` (nothing at all). A
   *     ±2 h search band is a reasonable default.
   *   - `window` is passed through so repos that prefer a strict
   *     database filter can use it directly; the service still
   *     re-validates the returned `classStartsAt` against the
   *     strict window (defense in depth).
   *   - If multiple confirmed reservations match, the repo SHOULD
   *     return the one whose `classStartsAt` is closest to `now`.
   *     Returning the wrong candidate is not a correctness bug —
   *     the service will surface `outside_window` in that case —
   *     but it degrades UX.
   *   - `null` means "no confirmed reservation for this user at
   *     this studio near this time"; the service maps it to
   *     `no_reservation`.
   *   - A reservation whose `checkedInAt` is already set MUST still
   *     be returned here so the service can surface
   *     `already_checked_in`. The repo does not filter out
   *     already-consumed rows.
   */
  findConfirmedForCheckin(
    userId: string,
    studioId: string,
    window: CheckinWindow,
  ): Promise<CheckinCandidate | null>;

  /**
   * Stamp `checkedInAt = at` on the reservation identified by
   * `reservationId` and return the updated row.
   *
   * Implementations SHOULD issue a single statement of the form
   *
   *     UPDATE reservations
   *     SET checked_in_at = $2
   *     WHERE id = $1 AND checked_in_at IS NULL
   *     RETURNING *
   *
   * The `WHERE checked_in_at IS NULL` guard is a belt-and-braces
   * check: the service already verified the field was null before
   * calling, but a concurrent check-in from another terminal could
   * in theory race. Returning the updated row lets the service
   * pass it straight to the gateway for serialisation.
   */
  markCheckedIn(reservationId: string, at: Date): Promise<ReservationRow>;
}

/**
 * Closed interval `[start, end]` bounding the strict 30-minute
 * check-in window (Requirement 11.6). Both `start` and `end` are
 * inclusive.
 */
export interface CheckinWindow {
  readonly start: Date;
  readonly end: Date;
}

/* ------------------------------------------------------------------ */
/*  Result type                                                        */
/* ------------------------------------------------------------------ */

/**
 * Terminal success outcome: the reservation was stamped.
 *
 * `reservation` is the row *after* the UPDATE, so `checkedInAt` is
 * guaranteed non-null.
 */
export interface CheckInOk {
  readonly code: 'ok';
  readonly reservation: ReservationRow;
}

/**
 * Codes surfaced when the business flow — not the QR token — rejects
 * the request. Each maps to an HTTP 404 (no_reservation) or HTTP 422
 * (already_checked_in / outside_window) at the API layer.
 *
 *   - `no_reservation`    — no confirmed reservation for `(userId,
 *     studioId)` near `now`.
 *   - `already_checked_in`— reservation exists, within window, but
 *     `checkedInAt` is already non-null.
 *   - `outside_window`    — reservation exists and is not yet
 *     checked in, but its class `startsAt` is outside
 *     `[now − 30 min, now + 30 min]`.
 */
export type CheckInBusinessFailure =
  | { readonly code: 'no_reservation' }
  | { readonly code: 'already_checked_in'; readonly reservation: ReservationRow }
  | { readonly code: 'outside_window'; readonly reservation: ReservationRow };

/**
 * Discriminated union returned by {@link checkIn}.
 *
 * Layout:
 *   - QR failure codes are **propagated verbatim** from
 *     {@link QRVerifyFailReason}, so consumers only have one place
 *     to look for the taxonomy.
 *   - Business failures (see {@link CheckInBusinessFailure}) include
 *     the offending reservation when available — the UI can use it
 *     to render a meaningful message ("you checked in at 09:02").
 *   - The success branch carries the fully-updated reservation.
 */
export type CheckInResult =
  CheckInOk | { readonly code: QRVerifyFailReason } | CheckInBusinessFailure;

/* ------------------------------------------------------------------ */
/*  Service input                                                      */
/* ------------------------------------------------------------------ */

/**
 * Injectable clock. `number` is Unix-ms to match `Date.now()`.
 *
 * Kept as `number` rather than `Date` because:
 *   1. The verifier uses `number` too (`() => Math.floor(Date.now()/1000)`),
 *      so both ports can share a test fixture.
 *   2. Arithmetic on window boundaries (`now - 30 min`) is a single
 *      subtraction on `number` versus an allocation on `Date`.
 */
export type Clock = () => number;

/**
 * Full argument set for {@link checkIn}. Destructured inside the
 * function body so callers get named-parameter ergonomics.
 */
export interface CheckInInput {
  /** Raw compact-JWS QR token handed over by the scanning terminal. */
  readonly token: string;
  /** Tenant the terminal belongs to. */
  readonly studioId: string;
  /** Pluggable port for signature / replay verification. */
  readonly qrVerifier: QRVerifier;
  /** Pluggable repo for the reservation read + stamp. */
  readonly repo: CheckinReservationRepo;
  /**
   * Optional clock override. Defaults to `Date.now`. Tests pin it
   * so the 30-minute window computation is deterministic.
   */
  readonly clock?: Clock;
}

/* ------------------------------------------------------------------ */
/*  Use case                                                           */
/* ------------------------------------------------------------------ */

/**
 * Execute a QR-triggered check-in.
 *
 * Flow (Requirement 11.2, 11.6):
 *
 *   1. Delegate signature / payload / window / replay checks to
 *      `qrVerifier.verify`. On any failure, surface the reason
 *      verbatim — no DB read happens. This enforces the "verify
 *      before touching the database" ordering that keeps a forged
 *      QR token from turning into a cheap DoS against Postgres.
 *   2. Compute the strict 30-minute window `[now − 30 min,
 *      now + 30 min]` from the injected clock.
 *   3. Ask the repo for the user's candidate confirmed reservation
 *      at this studio. `null` → `no_reservation`.
 *   4. If the candidate already carries `checkedInAt`, surface
 *      `already_checked_in`. We return the existing reservation so
 *      the UI can render "checked in at 09:02" without a second
 *      round-trip.
 *   5. If the class's `startsAt` falls outside the strict window,
 *      surface `outside_window`. Defense-in-depth over the repo's
 *      own filter — a buggy repo that over-returned by one second
 *      can never leak a past-class check-in.
 *   6. Otherwise, stamp `checkedInAt = now()` via
 *      `repo.markCheckedIn` and return the updated row as
 *      {@link CheckInOk}.
 *
 * This function never throws on expected business failures. Unexpected
 * failures (DB outage, port misbehaviour) propagate as thrown errors,
 * which the API gateway's global handler translates to HTTP 500 +
 * Problem Details with a `traceId`.
 */
export async function checkIn(input: CheckInInput): Promise<CheckInResult> {
  const { token, studioId, qrVerifier, repo } = input;
  const now = (input.clock ?? Date.now)();

  // ---- Step 1: QR verification -----------------------------------
  //
  // Delegates to the auth layer. Any failure short-circuits before
  // the repo is even constructed as a memory-resident object
  // (Requirement 11.2 — "before any database read"). The reason
  // code is passed straight through so the gateway never has to
  // translate it.
  const verifyResult = await qrVerifier.verify(token, studioId);
  if (!verifyResult.ok) {
    return { code: verifyResult.reason };
  }

  // ---- Step 2: strict 30-minute window ---------------------------
  //
  // Computed *after* QR verification succeeded so a malformed token
  // can't cause unnecessary Date allocations. `start` and `end` are
  // both inclusive — a reservation whose class starts exactly at
  // `now + 30 min` is valid.
  const window: CheckinWindow = {
    start: new Date(now - CHECKIN_WINDOW_HALF_MS),
    end: new Date(now + CHECKIN_WINDOW_HALF_MS),
  };

  // ---- Step 3: candidate lookup ----------------------------------
  const candidate = await repo.findConfirmedForCheckin(verifyResult.userId, studioId, window);
  if (candidate === null) {
    return { code: 'no_reservation' };
  }

  // ---- Step 4: already-consumed guard ----------------------------
  //
  // Checked *before* the window guard because a user who is already
  // checked in should always see the same message — they want to
  // know "you're in", not "you were in but you're now outside the
  // 30-minute window". The reservation they already consumed is
  // echoed back so the UI can render their check-in timestamp.
  if (candidate.reservation.checkedInAt !== null) {
    return {
      code: 'already_checked_in',
      reservation: candidate.reservation,
    };
  }

  // ---- Step 5: strict window filter ------------------------------
  //
  // Re-validates the window even though the repo is expected to
  // pre-filter. Two reasons:
  //   - Defence in depth: a repo bug cannot leak a too-early
  //     check-in that would break the waitlist promotion window.
  //   - The repo deliberately broadens its search band so the
  //     service can surface `outside_window` instead of a less
  //     actionable `no_reservation` — the strict filter here is
  //     what makes that design work.
  const startMs = candidate.classStartsAt.getTime();
  if (startMs < window.start.getTime() || startMs > window.end.getTime()) {
    return {
      code: 'outside_window',
      reservation: candidate.reservation,
    };
  }

  // ---- Step 6: stamp checked_in_at -------------------------------
  //
  // `now` is reused so the timestamp persisted in the DB matches
  // the clock reading the window was computed from — keeps log
  // timestamps consistent across a single request.
  const updated = await repo.markCheckedIn(candidate.reservation.id, new Date(now));

  return { code: 'ok', reservation: updated };
}
