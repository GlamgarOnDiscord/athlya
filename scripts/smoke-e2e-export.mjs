#!/usr/bin/env node
/**
 * End-to-end RGPD export smoke — issue #498.
 *
 * Proves the Art. 15/20 export against a deployed API (staging) with its
 * real Postgres, Queue and R2 bindings:
 *
 *   1. log in as the smoke account (and as a second, unrelated account);
 *   2. log a workout session whose notes are a CSV-injection probe;
 *   3. POST /v1/members/me/export and poll the job until it completes;
 *   4. download the archive through its signed link and validate the
 *      ZIP: every expected file, JSON/CSV agreement, CSV quoting, CRLF
 *      endings, formula neutralisation and the probe round-trip;
 *   5. prove the link is access-controlled and expiring: no token → 401,
 *      the other account → 403/404, a tampered signature, a past expiry
 *      or a stretched expiry → 403, and the signed expiry is the 72 h
 *      window of Requirement 4.2.
 *
 * `POST /v1/members/me/export` is limited to one request per user per
 * 24 h, so this script is not part of the per-PR staging gate: it runs
 * from `.github/workflows/staging-export-e2e.yml` (manual + weekly).
 * `--job-id` validates an export already requested by the smoke account
 * (e.g. a rerun inside the 24 h window); the probe check is then skipped
 * because the archive predates this run.
 *
 * Every run adds one workout session (the probe) to the smoke account;
 * sessions cannot be deleted through the API.
 *
 * Usage:
 *   SMOKE_EMAIL=… SMOKE_PASSWORD=… SMOKE_STUDIO_SLUG=… \
 *   SMOKE_OTHER_EMAIL=… SMOKE_OTHER_PASSWORD=… \
 *     node scripts/smoke-e2e-export.mjs --base-url https://staging.api.athlya.app \
 *     [--timeout-sec 900] [--job-id <uuid>]
 *
 * Optional: SMOKE_TURNSTILE_TOKEN and SMOKE_OTHER_TURNSTILE_TOKEN, sent as
 * `cf-turnstile-token` on the owner and other-account logins. A real
 * token is single-use, so each login needs its own; the other login falls
 * back to SMOKE_TURNSTILE_TOKEN, which only works with Cloudflare's
 * Turnstile test secret (any token passes, repeatedly).
 *
 * Exit 0 = export verified. Exit 1 = a step failed (reason on stderr).
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
/** Refresh an access token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Requirement 4.2: signed links expire 72 h after issuance. */
export const DOWNLOAD_TTL_SEC = 72 * 60 * 60;
/** Slack between the signed expiry and the stored `downloadExpiresAt`. */
const EXPIRY_TOLERANCE_SEC = 60;

/** Cells a spreadsheet would run as a formula (mirrors @athlya/members). */
const FORMULA_TRIGGER = /^[=+\-@\t\r\n＝＋－＠]/u;

/** CSV headers of each collection, in archive order (Requirement 4.4). */
export const CSV_HEADERS = {
  'reservations.csv': [
    'id',
    'classId',
    'userId',
    'status',
    'createdAt',
    'cancelledAt',
    'checkedInAt',
  ],
  'workout_sessions.csv': [
    'id',
    'userId',
    'studioId',
    'startedAt',
    'durationMin',
    'exercisesJson',
    'notes',
    'cardioJson',
    'createdAt',
    'source',
    'externalId',
  ],
  'checkins.csv': ['reservationId', 'classId', 'checkedInAt'],
  'invoices.csv': ['id', 'issuedAt', 'amountCents', 'currency', 'description', 'pdfUrl'],
};

export const REQUIRED_ENTRIES = [
  'README.txt',
  'profile.json',
  'consents.json',
  'reservations.json',
  'reservations.csv',
  'workout_sessions.json',
  'workout_sessions.csv',
  'checkins.json',
  'checkins.csv',
  'invoices.json',
  'invoices.csv',
  'audit_trail.json',
];

/** Notes of the probe session: formula trigger, quotes, comma and a line break. */
export function probeNote(runId) {
  return `=HYPERLINK("https://example.invalid/${runId}","smoke"), export probe\r\nline 2`;
}

/* ------------------------------------------------------------------ */
/*  ZIP                                                                */
/* ------------------------------------------------------------------ */

/**
 * Read every file of a ZIP archive through its central directory.
 * Supports stored (0) and deflated (8) entries and checks each CRC-32.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
export function readZip(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('zip: malformed central directory');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`zip: ${name} is encrypted`);
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`);
    }
    if (files.has(name)) throw new Error(`zip: duplicate entry ${name}`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`zip: malformed local header for ${name}`);
    }
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) throw new Error(`zip: ${name} is truncated`);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: ${name} uses unsupported method ${method}`);
    if (data.length !== size) throw new Error(`zip: ${name} has the wrong size`);
    if (crc32(data) >>> 0 !== crc) throw new Error(`zip: ${name} fails its CRC-32`);
    files.set(name, new Uint8Array(data));
  }
  return files;
}

/* ------------------------------------------------------------------ */
/*  CSV                                                                */
/* ------------------------------------------------------------------ */

/**
 * Strict parser for the export's CSV dialect: every cell quoted, `""`
 * for an embedded quote, `,` between cells, CRLF after every record.
 * Anything else (an unquoted cell, a bare LF record end, a stray quote)
 * throws, so a regression in the encoder fails the smoke.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseStrictCsv(text) {
  const records = [];
  let i = 0;
  while (i < text.length) {
    const record = [];
    for (;;) {
      if (text[i] !== '"') throw new Error(`csv: unquoted cell at offset ${i}`);
      i += 1;
      let cell = '';
      for (;;) {
        const next = text.indexOf('"', i);
        if (next < 0) throw new Error('csv: unterminated quoted cell');
        cell += text.slice(i, next);
        if (text[next + 1] === '"') {
          cell += '"';
          i = next + 2;
        } else {
          i = next + 1;
          break;
        }
      }
      record.push(cell);
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text.startsWith('\r\n', i)) {
        i += 2;
        break;
      }
      throw new Error(`csv: expected "," or CRLF at offset ${i}`);
    }
    records.push(record);
  }
  if (records.length === 0) throw new Error('csv: missing header row');
  return records;
}

/* ------------------------------------------------------------------ */
/*  Archive                                                            */
/* ------------------------------------------------------------------ */

/**
 * Validate the structure and encoding of an export archive.
 *
 * @param {Map<string, Uint8Array>} files
 * @param {{ email?: string, probe?: { sessionId: string, notes: string } }} [expect]
 * @returns {string[]} failures (empty when the archive is valid)
 */
export function validateArchive(files, expect = {}) {
  const failures = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = (name) => decoder.decode(files.get(name));
  const json = (name) => {
    try {
      return JSON.parse(text(name));
    } catch (err) {
      failures.push(`${name}: not valid UTF-8 JSON (${err instanceof Error ? err.message : err})`);
      return undefined;
    }
  };

  for (const name of REQUIRED_ENTRIES) {
    if (!files.has(name)) failures.push(`missing ${name}`);
  }
  for (const name of files.keys()) {
    if (!REQUIRED_ENTRIES.includes(name)) failures.push(`unexpected entry ${name}`);
  }
  if (failures.length > 0) return failures;

  const profile = json('profile.json');
  if (profile !== undefined) {
    if (typeof profile?.id !== 'string' || typeof profile?.email !== 'string') {
      failures.push('profile.json: missing id or email');
    } else if (expect.email && profile.email.toLowerCase() !== expect.email.toLowerCase()) {
      failures.push('profile.json: belongs to another account');
    }
    if (profile && ('passwordHash' in profile || 'password_hash' in profile)) {
      failures.push('profile.json: leaks the password hash');
    }
  }
  const consents = json('consents.json');
  if (consents !== undefined && !Array.isArray(consents)) {
    failures.push('consents.json: not an array');
  }
  const audit = json('audit_trail.json');
  if (audit !== undefined && !Array.isArray(audit)) {
    failures.push('audit_trail.json: not an array');
  }
  if (!text('README.txt').includes('invoices')) {
    failures.push('README.txt: does not describe the invoices section');
  }

  for (const [csvName, header] of Object.entries(CSV_HEADERS)) {
    const jsonName = csvName.replace(/\.csv$/u, '.json');
    const rows = json(jsonName);
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      failures.push(`${jsonName}: not an array`);
      continue;
    }
    let records;
    try {
      records = parseStrictCsv(text(csvName));
    } catch (err) {
      failures.push(`${csvName}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (JSON.stringify(records[0]) !== JSON.stringify(header)) {
      failures.push(`${csvName}: header is ${JSON.stringify(records[0])}`);
    }
    const body = records.slice(1);
    if (body.length !== rows.length) {
      failures.push(`${csvName}: ${body.length} rows but ${jsonName} has ${rows.length}`);
    }
    body.forEach((record, index) => {
      if (record.length !== header.length) {
        failures.push(`${csvName}: row ${index + 1} has ${record.length} cells`);
      }
      record.forEach((cell, column) => {
        if (FORMULA_TRIGGER.test(cell)) {
          failures.push(`${csvName}: row ${index + 1} ${header[column]} is not neutralised`);
        }
      });
    });
  }

  if (expect.probe) {
    const { sessionId, notes } = expect.probe;
    const sessions = json('workout_sessions.json');
    const stored = Array.isArray(sessions) ? sessions.find((s) => s?.id === sessionId) : null;
    if (!stored) failures.push('workout_sessions.json: probe session missing');
    else if (stored.notes !== notes) failures.push('workout_sessions.json: probe notes altered');
    try {
      const records = parseStrictCsv(text('workout_sessions.csv'));
      const header = records[0];
      const row = records.slice(1).find((r) => r[header.indexOf('id')] === sessionId);
      if (!row) failures.push('workout_sessions.csv: probe session missing');
      else if (row[header.indexOf('notes')] !== `'${notes}`) {
        failures.push('workout_sessions.csv: probe notes not escaped as expected');
      }
    } catch {
      // Already reported by the structural pass.
    }
  }
  return failures;
}

/* ------------------------------------------------------------------ */
/*  Download link                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse a signed download link and check it targets the API itself, so
 * the bearer token is never sent to another origin.
 *
 * @returns {{ url: URL, exp: number, sig: string }}
 */
export function parseDownloadLink(downloadUrl, baseUrl, jobId) {
  const url = new URL(downloadUrl);
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error(`download link points at ${url.origin}, not the API origin`);
  }
  if (url.pathname !== `/v1/members/me/export/${jobId}/download`) {
    throw new Error(`download link has an unexpected path ${url.pathname}`);
  }
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!Number.isSafeInteger(exp) || sig.length === 0) {
    throw new Error('download link is missing exp or sig');
  }
  return { url, exp, sig };
}

/** Same link with `exp` / `sig` replaced. */
export function withLinkParams(url, params) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) next.searchParams.set(key, String(value));
  return next.toString();
}

/** Flip the first character of a base64url signature. */
export function tamperSignature(sig) {
  return `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
}

/**
 * Check the signed expiry: in the future, about 72 h after completion,
 * and equal to the stored `downloadExpiresAt`.
 *
 * @returns {string[]} failures
 */
export function checkExpiry({ exp, completedAt, downloadExpiresAt, nowSec }) {
  const failures = [];
  const completedSec = Math.floor(Date.parse(completedAt) / 1000);
  const storedSec = Math.floor(Date.parse(downloadExpiresAt) / 1000);
  if (!(exp > nowSec)) failures.push('signed link is already expired');
  if (!Number.isFinite(storedSec) || Math.abs(exp - storedSec) > EXPIRY_TOLERANCE_SEC) {
    failures.push('signed expiry does not match downloadExpiresAt');
  }
  if (!Number.isFinite(completedSec) || Math.abs(exp - completedSec - DOWNLOAD_TTL_SEC) > 300) {
    failures.push('signed link does not expire 72 h after completion');
  }
  return failures;
}

/* ------------------------------------------------------------------ */
/*  Flow                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   baseUrl: string,
 *   email: string,
 *   password: string,
 *   otherEmail: string,
 *   otherPassword: string,
 *   studioSlug: string,
 *   turnstileToken?: string,
 *   otherTurnstileToken?: string,
 *   jobId?: string,
 *   jobTimeoutMs?: number,
 *   pollIntervalMs?: number,
 *   runId?: string,
 *   now?: () => Date,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   fetchImpl?: typeof fetch,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, steps: string[], error?: string, jobId?: string }>}
 */
export async function runExportFlow({
  baseUrl,
  email,
  password,
  otherEmail,
  otherPassword,
  studioSlug,
  turnstileToken,
  otherTurnstileToken = turnstileToken,
  jobId: existingJobId,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  runId = randomUUID(),
  now = () => new Date(),
  sleep = delay,
  fetchImpl = fetch,
  log = console.log,
}) {
  const steps = [];
  let jobId = existingJobId;

  function step(name) {
    steps.push(name);
    log(`[smoke-export] OK   ${name}`);
  }

  async function request(method, url, { token, body, headers = {} } = {}) {
    return fetchImpl(url, {
      method,
      headers: {
        'x-studio-slug': studioSlug,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function call(method, path, options) {
    const res = await request(method, `${baseUrl}${path}`, options);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /**
   * Log in and keep the session usable for the whole run: access tokens
   * live 15 min and the job may take longer, so `token()` rotates the
   * refresh token shortly before the access token expires.
   */
  async function openSession(who, user, pass, turnstile) {
    const login = await call('POST', '/v1/auth/login', {
      body: { email: user, password: pass },
      headers: turnstile ? { 'cf-turnstile-token': turnstile } : {},
    });
    if (login.status !== 200 || typeof login.json?.accessToken !== 'string') {
      throw new Error(`login (${who}): expected 200 with accessToken, got ${login.status}`);
    }
    let current = login.json;
    let issuedAt = now().getTime();
    return {
      async token() {
        const ttlMs = (Number(current.accessTokenExpiresIn) || 0) * 1000;
        if (now().getTime() < issuedAt + ttlMs - TOKEN_REFRESH_MARGIN_MS) {
          return current.accessToken;
        }
        if (typeof current.refreshToken !== 'string') {
          throw new Error(`refresh (${who}): login returned no refresh token`);
        }
        const res = await call('POST', '/v1/auth/refresh', {
          body: { refreshToken: current.refreshToken },
        });
        if (res.status !== 200 || typeof res.json?.accessToken !== 'string') {
          throw new Error(`refresh (${who}): expected 200 with accessToken, got ${res.status}`);
        }
        current = res.json;
        issuedAt = now().getTime();
        return current.accessToken;
      },
    };
  }

  try {
    const owner = await openSession('owner', email, password, turnstileToken);
    const other = await openSession('other', otherEmail, otherPassword, otherTurnstileToken);
    step('login (owner + other account)');

    let probe;
    if (jobId === undefined) {
      const notes = probeNote(runId);
      const session = await call('POST', '/v1/sessions', {
        token: await owner.token(),
        body: {
          startedAt: new Date(now().getTime() - 60_000).toISOString(),
          durationMin: 1,
          exercises: [],
          notes,
        },
        headers: { 'idempotency-key': randomUUID() },
      });
      if (session.status !== 201 || typeof session.json?.id !== 'string') {
        throw new Error(`log probe session: expected 201 with an id, got ${session.status}`);
      }
      probe = { sessionId: session.json.id, notes };
      step('log CSV-injection probe session');

      const enqueued = await call('POST', '/v1/members/me/export', {
        token: await owner.token(),
        headers: { 'idempotency-key': randomUUID() },
      });
      if (enqueued.status === 429) {
        throw new Error(
          'request export: rate limited (1 export per user per 24 h) — rerun later or pass --job-id',
        );
      }
      if (enqueued.status !== 202 || typeof enqueued.json?.jobId !== 'string') {
        throw new Error(`request export: expected 202 with jobId, got ${enqueued.status}`);
      }
      jobId = enqueued.json.jobId;
      step(`request export (${jobId})`);
    }

    const statusPath = `/v1/members/me/export/${encodeURIComponent(jobId)}`;
    const deadline = now().getTime() + jobTimeoutMs;
    let job;
    for (;;) {
      const res = await call('GET', statusPath, { token: await owner.token() });
      if (res.status !== 200) throw new Error(`poll export: expected 200, got ${res.status}`);
      job = res.json;
      if (job?.status === 'completed') break;
      if (job?.status === 'failed') {
        throw new Error(`export failed: ${job.error ?? 'no reason recorded'}`);
      }
      if (now().getTime() >= deadline) {
        throw new Error(`export still ${job?.status} after ${Math.round(jobTimeoutMs / 1000)} s`);
      }
      await sleep(pollIntervalMs);
    }
    if (typeof job.downloadUrl !== 'string') {
      throw new Error('export completed without a live download link');
    }
    step('export completed');

    const otherStatus = await call('GET', statusPath, { token: await other.token() });
    if (otherStatus.status !== 404) {
      throw new Error(
        `other account reads the job status: expected 404, got ${otherStatus.status}`,
      );
    }
    step('job status hidden from the other account');

    const link = parseDownloadLink(job.downloadUrl, baseUrl, jobId);
    const nowSec = Math.floor(now().getTime() / 1000);
    const expiryFailures = checkExpiry({
      exp: link.exp,
      completedAt: job.completedAt,
      downloadExpiresAt: job.downloadExpiresAt,
      nowSec,
    });
    if (expiryFailures.length > 0) throw new Error(expiryFailures.join('; '));
    step('signed link expires 72 h after completion');

    const download = await request('GET', job.downloadUrl, { token: await owner.token() });
    if (download.status !== 200) {
      throw new Error(`download: expected 200, got ${download.status}`);
    }
    if (!(download.headers.get('content-type') ?? '').startsWith('application/zip')) {
      throw new Error('download: content-type is not application/zip');
    }
    if (!/no-store/u.test(download.headers.get('cache-control') ?? '')) {
      throw new Error('download: response is cacheable');
    }
    const files = readZip(new Uint8Array(await download.arrayBuffer()));
    step(`download archive (${files.size} files)`);

    const failures = validateArchive(files, { email, probe });
    if (failures.length > 0) throw new Error(`archive: ${failures.join('; ')}`);
    step(probe ? 'archive structure, CSV escaping and probe' : 'archive structure, CSV escaping');

    const token = await owner.token();
    const otherToken = await other.token();
    const denials = [
      ['no token', job.downloadUrl, undefined, [401]],
      ['other account', job.downloadUrl, otherToken, [403, 404]],
      [
        'tampered signature',
        withLinkParams(job.downloadUrl, { sig: tamperSignature(link.sig) }),
        token,
        [403],
      ],
      ['past expiry', withLinkParams(job.downloadUrl, { exp: nowSec - 60 }), token, [403]],
      ['stretched expiry', withLinkParams(job.downloadUrl, { exp: link.exp + 3600 }), token, [403]],
    ];
    for (const [name, url, bearer, allowed] of denials) {
      const res = await request('GET', url, { token: bearer });
      await res.body?.cancel();
      if (!allowed.includes(res.status)) {
        throw new Error(`download with ${name}: expected ${allowed.join('/')}, got ${res.status}`);
      }
    }
    step('link refused without auth, for the other account and when altered or expired');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`[smoke-export] FAIL ${error}`);
    return { ok: false, steps, error, jobId };
  }
  return { ok: true, steps, jobId };
}

/**
 * Required configuration, in the order it is reported when missing.
 * @returns {string[]} names of the missing settings
 */
export function missingConfig(baseUrl, env) {
  return [
    ['--base-url / STAGING_API_URL', baseUrl],
    ['SMOKE_EMAIL', env.SMOKE_EMAIL],
    ['SMOKE_PASSWORD', env.SMOKE_PASSWORD],
    ['SMOKE_STUDIO_SLUG', env.SMOKE_STUDIO_SLUG],
    ['SMOKE_OTHER_EMAIL', env.SMOKE_OTHER_EMAIL],
    ['SMOKE_OTHER_PASSWORD', env.SMOKE_OTHER_PASSWORD],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      'timeout-sec': { type: 'string' },
      'job-id': { type: 'string' },
    },
  });
  const baseUrl = values['base-url'] ?? process.env.STAGING_API_URL;
  const missing = missingConfig(baseUrl, process.env);
  if (missing.length > 0) {
    console.error(`[smoke-export] missing ${missing.join(', ')}`);
    process.exit(1);
  }
  if (new URL(baseUrl).protocol !== 'https:') {
    console.error('[smoke-export] --base-url must be https');
    process.exit(1);
  }
  if (process.env.SMOKE_OTHER_EMAIL.toLowerCase() === process.env.SMOKE_EMAIL.toLowerCase()) {
    console.error('[smoke-export] SMOKE_OTHER_EMAIL must be a different account');
    process.exit(1);
  }
  if (values['job-id'] !== undefined && !/^[0-9a-f-]{36}$/iu.test(values['job-id'])) {
    console.error('[smoke-export] --job-id must be a UUID');
    process.exit(1);
  }
  const timeoutSec = Number(values['timeout-sec'] ?? DEFAULT_JOB_TIMEOUT_MS / 1000);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    console.error('[smoke-export] --timeout-sec must be a positive number');
    process.exit(1);
  }

  const { ok, error } = await runExportFlow({
    baseUrl: baseUrl.replace(/\/+$/u, ''),
    email: process.env.SMOKE_EMAIL,
    password: process.env.SMOKE_PASSWORD,
    otherEmail: process.env.SMOKE_OTHER_EMAIL,
    otherPassword: process.env.SMOKE_OTHER_PASSWORD,
    studioSlug: process.env.SMOKE_STUDIO_SLUG,
    turnstileToken: process.env.SMOKE_TURNSTILE_TOKEN || undefined,
    otherTurnstileToken:
      process.env.SMOKE_OTHER_TURNSTILE_TOKEN || process.env.SMOKE_TURNSTILE_TOKEN || undefined,
    jobId: values['job-id'],
    jobTimeoutMs: timeoutSec * 1000,
  });
  if (!ok) {
    console.error(`[smoke-export] export E2E failed: ${error}`);
    process.exit(1);
  }
  console.log('[smoke-export] request → complete → download → validate → access control OK');
}
