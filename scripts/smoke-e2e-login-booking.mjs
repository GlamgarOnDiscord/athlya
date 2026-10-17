#!/usr/bin/env node
/**
 * End-to-end booking smoke — issue #470.
 *
 * Proves the member journey against a deployed API (staging by default):
 * login → list the studio's classes → book a class with a free seat →
 * cancel that reservation. Cancellation is attempted even when a later
 * assertion fails or the process receives SIGINT/SIGTERM (a cancelled CI
 * run), so the smoke account does not accumulate seats; a failed cleanup
 * is logged with the reservation id for manual cancellation.
 *
 * A Turnstile token is single-use, so in CI the session opened by
 * `smoke-routes.mjs --session-file` is reused via `--session-file` instead
 * of logging in a second time. Without a usable session file the script
 * logs in itself.
 *
 * A class already booked by the smoke account (HTTP 409, e.g. a
 * concurrent gate run on another ref) is skipped in favour of the next
 * bookable class, and that reservation is left to its owner.
 *
 * Usage:
 *   SMOKE_EMAIL=… SMOKE_PASSWORD=… SMOKE_STUDIO_SLUG=… [SMOKE_TURNSTILE_TOKEN=…] \
 *     node scripts/smoke-e2e-login-booking.mjs --base-url https://staging.api.athlya.app \
 *     [--session-file "$RUNNER_TEMP/smoke-session"]
 *
 * Exit 0 = journey succeeded. Exit 1 = a step failed (reason on stderr).
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const TIMEOUT_MS = 15_000;

/** `GET /v1/classes` requires `from`/`to`; the API caps the range at 90 days. */
const CLASS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * @param {{
 *   baseUrl: string,
 *   email?: string,
 *   password?: string,
 *   studioSlug: string,
 *   turnstileToken?: string,
 *   accessToken?: string,
 *   shouldStop?: () => boolean,
 *   now?: () => Date,
 *   fetchImpl?: typeof fetch,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, steps: string[], error?: string }>}
 */
export async function runBookingFlow({
  baseUrl,
  email,
  password,
  studioSlug,
  turnstileToken,
  accessToken,
  shouldStop = () => false,
  now = () => new Date(),
  fetchImpl = fetch,
  log = console.log,
}) {
  const steps = [];
  let reservationId = null;
  let headers = { 'content-type': 'application/json', 'x-studio-slug': studioSlug };

  async function call(method, path, { body, extraHeaders = {} } = {}) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  function step(name) {
    steps.push(name);
    log(`[smoke-e2e] OK   ${name}`);
  }

  function checkpoint() {
    if (shouldStop()) throw new Error(`interrupted after ${steps.at(-1)}`);
  }

  try {
    if (accessToken) {
      headers = { ...headers, authorization: `Bearer ${accessToken}` };
      step('reuse session');
      checkpoint();
    } else {
      const login = await call('POST', '/v1/auth/login', {
        body: { email, password },
        extraHeaders: turnstileToken ? { 'cf-turnstile-token': turnstileToken } : {},
      });
      if (login.status !== 200 || typeof login.json?.accessToken !== 'string') {
        throw new Error(`login: expected 200 with accessToken, got ${login.status}`);
      }
      headers = { ...headers, authorization: `Bearer ${login.json.accessToken}` };
      step('login');
      checkpoint();
    }

    const reference = now().getTime();
    const range = new URLSearchParams({
      from: new Date(reference).toISOString(),
      to: new Date(reference + CLASS_WINDOW_MS).toISOString(),
    });
    const classes = await call('GET', `/v1/classes?${range}`);
    if (classes.status !== 200 || !Array.isArray(classes.json?.items)) {
      throw new Error(`list classes: expected 200 with items, got ${classes.status}`);
    }
    const bookable = classes.json.items.filter(
      (item) => item.remaining > 0 && Date.parse(item.startsAt) > reference,
    );
    if (bookable.length === 0) {
      throw new Error('list classes: no upcoming class with a free seat — seed the smoke studio');
    }
    step(`list classes (${classes.json.items.length})`);
    checkpoint();

    for (const candidate of bookable) {
      const booking = await call('POST', '/v1/reservations', {
        body: { classId: candidate.id },
        extraHeaders: { 'idempotency-key': randomUUID() },
      });
      if (booking.status === 409) {
        log(`[smoke-e2e] SKIP class ${candidate.id} is already booked by the smoke account`);
        continue;
      }
      reservationId = booking.json?.reservation?.id ?? null;
      if (![201, 202].includes(booking.status) || !reservationId) {
        throw new Error(`book: expected 201/202 with a reservation, got ${booking.status}`);
      }
      step(`book (${booking.json.status})`);
      break;
    }
    if (reservationId === null) {
      throw new Error('book: every bookable class is already booked by the smoke account');
    }
    checkpoint();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[smoke-e2e] FAIL ${error}`);
    await cancelQuietly();
    return { ok: false, steps, error };
  }

  const cancelled = await cancel();
  if (!cancelled.ok) {
    log(`[smoke-e2e] FAIL ${cancelled.error}`);
    return { ok: false, steps, error: cancelled.error };
  }
  step('cancel');
  return { ok: true, steps };

  async function cancel() {
    const res = await call('DELETE', `/v1/reservations/${reservationId}`, {
      extraHeaders: { 'idempotency-key': randomUUID() },
    });
    if (res.status === 200 || res.status === 204) {
      reservationId = null;
      return { ok: true };
    }
    return { ok: false, error: `cancel: expected 200/204, got ${res.status}` };
  }

  async function cancelQuietly() {
    if (reservationId === null) return;
    const pending = reservationId;
    try {
      const result = await cancel();
      if (!result.ok) {
        log(`[smoke-e2e] WARN ${result.error} — cancel reservation ${pending} manually`);
      }
    } catch {
      log(`[smoke-e2e] WARN could not cancel reservation ${pending} — cancel it manually`);
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { 'base-url': { type: 'string' }, 'session-file': { type: 'string' } },
  });
  const baseUrl = values['base-url'] ?? process.env.STAGING_API_URL;
  const { SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_STUDIO_SLUG, SMOKE_TURNSTILE_TOKEN } = process.env;
  const accessToken = values['session-file']
    ? (await readFile(values['session-file'], 'utf8').catch(() => '')).trim()
    : '';
  const missing = [
    ['--base-url / STAGING_API_URL', baseUrl],
    ['SMOKE_EMAIL', SMOKE_EMAIL || accessToken],
    ['SMOKE_PASSWORD', SMOKE_PASSWORD || accessToken],
    ['SMOKE_STUDIO_SLUG', SMOKE_STUDIO_SLUG],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    console.error(`[smoke-e2e] missing ${missing.join(', ')}`);
    process.exit(1);
  }

  // A cancelled CI run signals the process; finish the current request,
  // then let the flow cancel its reservation before exiting.
  let stopRequested = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopRequested = true;
      console.error(`[smoke-e2e] ${signal} received — cleaning up before exit`);
    });
  }

  const { ok, error } = await runBookingFlow({
    baseUrl,
    email: SMOKE_EMAIL,
    password: SMOKE_PASSWORD,
    studioSlug: SMOKE_STUDIO_SLUG,
    turnstileToken: SMOKE_TURNSTILE_TOKEN,
    accessToken: accessToken || undefined,
    shouldStop: () => stopRequested,
  });
  if (!ok) {
    console.error(`[smoke-e2e] journey failed: ${error}`);
    process.exit(1);
  }
  console.log('[smoke-e2e] login → classes → book → cancel succeeded');
}
