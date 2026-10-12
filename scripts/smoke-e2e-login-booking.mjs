#!/usr/bin/env node
/**
 * End-to-end booking smoke — issue #470.
 *
 * Proves the member journey against a deployed API (staging by default):
 * login → list the studio's classes → book a class with a free seat →
 * cancel that reservation. The reservation is always cancelled, even when
 * a later assertion fails, so the smoke account never accumulates seats.
 *
 * Usage:
 *   SMOKE_EMAIL=… SMOKE_PASSWORD=… SMOKE_STUDIO_SLUG=… [SMOKE_TURNSTILE_TOKEN=…] \
 *     node scripts/smoke-e2e-login-booking.mjs --base-url https://staging.api.athlya.app
 *
 * Exit 0 = journey succeeded. Exit 1 = a step failed (reason on stderr).
 */

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const TIMEOUT_MS = 15_000;

/**
 * @param {{
 *   baseUrl: string,
 *   email: string,
 *   password: string,
 *   studioSlug: string,
 *   turnstileToken?: string,
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

  try {
    const login = await call('POST', '/v1/auth/login', {
      body: { email, password },
      extraHeaders: turnstileToken ? { 'cf-turnstile-token': turnstileToken } : {},
    });
    if (login.status !== 200 || typeof login.json?.accessToken !== 'string') {
      throw new Error(`login: expected 200 with accessToken, got ${login.status}`);
    }
    headers = { ...headers, authorization: `Bearer ${login.json.accessToken}` };
    step('login');

    const classes = await call('GET', '/v1/classes');
    if (classes.status !== 200 || !Array.isArray(classes.json?.items)) {
      throw new Error(`list classes: expected 200 with items, got ${classes.status}`);
    }
    const reference = now().getTime();
    const bookable = classes.json.items.find(
      (item) => item.remaining > 0 && Date.parse(item.startsAt) > reference,
    );
    if (!bookable) {
      throw new Error('list classes: no upcoming class with a free seat — seed the smoke studio');
    }
    step(`list classes (${classes.json.items.length})`);

    const booking = await call('POST', '/v1/reservations', {
      body: { classId: bookable.id },
      extraHeaders: { 'idempotency-key': randomUUID() },
    });
    reservationId = booking.json?.reservation?.id ?? null;
    if (![201, 202].includes(booking.status) || !reservationId) {
      throw new Error(`book: expected 201/202 with a reservation, got ${booking.status}`);
    }
    step(`book (${booking.json.status})`);
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
    try {
      await cancel();
    } catch {
      log(`[smoke-e2e] WARN could not cancel reservation ${reservationId} — cancel it manually`);
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'base-url': { type: 'string' } } });
  const baseUrl = values['base-url'] ?? process.env.STAGING_API_URL;
  const { SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_STUDIO_SLUG, SMOKE_TURNSTILE_TOKEN } = process.env;
  const missing = [
    ['--base-url / STAGING_API_URL', baseUrl],
    ['SMOKE_EMAIL', SMOKE_EMAIL],
    ['SMOKE_PASSWORD', SMOKE_PASSWORD],
    ['SMOKE_STUDIO_SLUG', SMOKE_STUDIO_SLUG],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    console.error(`[smoke-e2e] missing ${missing.join(', ')}`);
    process.exit(1);
  }

  const { ok, error } = await runBookingFlow({
    baseUrl,
    email: SMOKE_EMAIL,
    password: SMOKE_PASSWORD,
    studioSlug: SMOKE_STUDIO_SLUG,
    turnstileToken: SMOKE_TURNSTILE_TOKEN,
  });
  if (!ok) {
    console.error(`[smoke-e2e] journey failed: ${error}`);
    process.exit(1);
  }
  console.log('[smoke-e2e] login → classes → book → cancel succeeded');
}
