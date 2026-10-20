import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  checkExpiry,
  missingConfig,
  parseDownloadLink,
  parseStrictCsv,
  probeNote,
  readZip,
  runExportFlow,
  tamperSignature,
  validateArchive,
  withLinkParams,
} from '../smoke-e2e-export.mjs';

const BASE = 'https://staging.example';
const JOB_ID = '0193f000-0000-7000-8000-000000000498';
const SESSION_ID = '0193f000-0000-7000-8000-000000005e55';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-17T10:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const EXP = NOW_SEC + 72 * 3600;

/** Minimal ZIP writer (stored or deflated entries) for the fixtures. */
function zip(entries, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const body = deflate ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

/** Same encoding as `toCsvBytes` in @athlya/members. */
function csv(header, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = /^[=+\-@\t\r\n＝＋－＠]/u.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function archiveEntries(notes = probeNote('run-1')) {
  const session = {
    id: SESSION_ID,
    userId: USER_ID,
    studioId: null,
    startedAt: '2026-10-17T09:59:00.000Z',
    durationMin: 1,
    exercises: [],
    notes,
    createdAt: '2026-10-17T09:59:01.000Z',
  };
  return [
    ['README.txt', 'Invoices: Athlya does not issue invoices to members (invoices.json is empty).'],
    ['profile.json', JSON.stringify({ id: USER_ID, email: 'smoke@example.com' })],
    ['consents.json', JSON.stringify([{ marketing: false }])],
    ['reservations.json', '[]'],
    ['reservations.csv', csv(HEADERS.reservations, [])],
    ['workout_sessions.json', JSON.stringify([session])],
    [
      'workout_sessions.csv',
      csv(HEADERS.sessions, [
        [
          session.id,
          session.userId,
          session.studioId,
          session.startedAt,
          session.durationMin,
          JSON.stringify(session.exercises),
          session.notes,
          null,
          session.createdAt,
          null,
          null,
        ],
      ]),
    ],
    ['checkins.json', '[]'],
    ['checkins.csv', csv(HEADERS.checkins, [])],
    ['invoices.json', '[]'],
    ['invoices.csv', csv(HEADERS.invoices, [])],
    ['audit_trail.json', '[]'],
  ];
}

/** Column contract of `buildArchiveEntries` (@athlya/members), independent of the script. */
const HEADERS = {
  reservations: ['id', 'classId', 'userId', 'status', 'createdAt', 'cancelledAt', 'checkedInAt'],
  sessions: [
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
  checkins: ['reservationId', 'classId', 'checkedInAt'],
  invoices: ['id', 'issuedAt', 'amountCents', 'currency', 'description', 'pdfUrl'],
};

const PROBE = { sessionId: SESSION_ID, notes: probeNote('run-1') };

describe('readZip', () => {
  it('reads stored and deflated entries', () => {
    for (const deflate of [false, true]) {
      const files = readZip(
        zip(
          [
            ['a.txt', 'hello'],
            ['b.json', '{"x":1}'],
          ],
          { deflate },
        ),
      );
      assert.deepEqual([...files.keys()], ['a.txt', 'b.json']);
      assert.equal(new TextDecoder().decode(files.get('b.json')), '{"x":1}');
    }
  });

  it('rejects a corrupted entry, a traversal name and a non-zip body', () => {
    const bytes = zip([['a.txt', 'hello']]);
    bytes[30 + 'a.txt'.length] ^= 0xff;
    assert.throws(() => readZip(bytes), /CRC-32/);
    assert.throws(() => readZip(zip([['../evil', 'x']])), /unsafe entry/);
    assert.throws(() => readZip(new TextEncoder().encode('<html>nope</html>')), /central/);
  });
});

describe('parseStrictCsv', () => {
  it('decodes doubled quotes, commas and embedded line breaks', () => {
    assert.deepEqual(parseStrictCsv('"a","b"\r\n"x ""y"", z","1\r\n2"\r\n'), [
      ['a', 'b'],
      ['x "y", z', '1\r\n2'],
    ]);
  });

  it('rejects unquoted cells, LF record ends and stray quotes', () => {
    assert.throws(() => parseStrictCsv('a,"b"\r\n'), /unquoted/);
    assert.throws(() => parseStrictCsv('"a","b"\n'), /CRLF/);
    assert.throws(() => parseStrictCsv('"a"x"\r\n'), /CRLF/);
    assert.throws(() => parseStrictCsv('"a\r\n'), /unterminated/);
    assert.throws(() => parseStrictCsv(''), /header/);
  });
});

describe('validateArchive', () => {
  it('accepts a well-formed archive with the escaped probe', () => {
    const files = readZip(zip(archiveEntries()));
    assert.deepEqual(validateArchive(files, { email: 'Smoke@Example.com', probe: PROBE }), []);
  });

  it('reports a missing or unexpected file', () => {
    const entries = archiveEntries().filter(([name]) => name !== 'invoices.csv');
    entries.push(['secrets.txt', 'x']);
    const failures = validateArchive(readZip(zip(entries)));
    assert.ok(failures.includes('missing invoices.csv'));
    assert.ok(failures.includes('unexpected entry secrets.txt'));
  });

  it('reports an unneutralised formula and a JSON/CSV row mismatch', () => {
    const entries = archiveEntries().map(([name, content]) =>
      name === 'checkins.csv'
        ? [name, `${content}"=cmd","c1","2026-10-17T09:00:00Z"\r\n`]
        : [name, content],
    );
    const failures = validateArchive(readZip(zip(entries)));
    assert.ok(
      failures.some((f) => /checkins\.csv: row 1 reservationId is not neutralised/.test(f)),
    );
    assert.ok(failures.some((f) => /checkins\.csv: 1 rows but checkins\.json has 0/.test(f)));
  });

  it('reports a probe that lost its escaping and an archive of another account', () => {
    const entries = archiveEntries().map(([name, content]) =>
      name === 'workout_sessions.csv' ? [name, content.replace(`"'=`, '"‘=')] : [name, content],
    );
    const failures = validateArchive(readZip(zip(entries)), {
      email: 'someone@else.example',
      probe: PROBE,
    });
    assert.ok(failures.includes('profile.json: belongs to another account'));
    assert.ok(failures.includes('workout_sessions.csv: probe notes not escaped as expected'));
  });

  it('reports a wrong CSV header', () => {
    const entries = archiveEntries().map(([name, content]) =>
      name === 'invoices.csv' ? [name, '"id"\r\n'] : [name, content],
    );
    const failures = validateArchive(readZip(zip(entries)));
    assert.ok(failures.some((f) => f.startsWith('invoices.csv: header is')));
  });
});

describe('download link helpers', () => {
  const link = `${BASE}/v1/members/me/export/${JOB_ID}/download?exp=${EXP}&sig=abc`;

  it('parses a link on the API origin and refuses any other origin or path', () => {
    assert.deepEqual((({ exp, sig }) => ({ exp, sig }))(parseDownloadLink(link, BASE, JOB_ID)), {
      exp: EXP,
      sig: 'abc',
    });
    assert.throws(() =>
      parseDownloadLink(link.replace(BASE, 'https://evil.example'), BASE, JOB_ID),
    );
    assert.throws(() => parseDownloadLink(link, BASE, 'other-job'), /path/);
    assert.throws(() => parseDownloadLink(link.replace('&sig=abc', ''), BASE, JOB_ID), /sig/);
  });

  it('rewrites query params and tampers a signature', () => {
    assert.match(withLinkParams(link, { exp: 1 }), /exp=1&sig=abc$/);
    assert.equal(tamperSignature('Axyz'), 'Bxyz');
    assert.equal(tamperSignature('xyz'), 'Ayz');
  });

  it('checks the 72 h expiry against the stored timestamps', () => {
    const ok = {
      exp: EXP,
      completedAt: NOW.toISOString(),
      downloadExpiresAt: new Date(EXP * 1000).toISOString(),
      nowSec: NOW_SEC,
    };
    assert.deepEqual(checkExpiry(ok), []);
    assert.ok(checkExpiry({ ...ok, nowSec: EXP }).includes('signed link is already expired'));
    assert.ok(
      checkExpiry({ ...ok, exp: EXP + 7 * 24 * 3600 }).includes(
        'signed link does not expire 72 h after completion',
      ),
    );
  });
});

describe('missingConfig', () => {
  it('fails closed on every missing credential', () => {
    assert.deepEqual(missingConfig(undefined, {}), [
      '--base-url / STAGING_API_URL',
      'SMOKE_EMAIL',
      'SMOKE_PASSWORD',
      'SMOKE_STUDIO_SLUG',
      'SMOKE_OTHER_EMAIL',
      'SMOKE_OTHER_PASSWORD',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  Flow against a fake API                                            */
/* ------------------------------------------------------------------ */

function json(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeApi({ statuses = ['pending', 'running', 'completed'], overrides = {} } = {}) {
  const calls = [];
  const queue = [...statuses];
  const downloadUrl = `${BASE}/v1/members/me/export/${JOB_ID}/download?exp=${EXP}&sig=goodsig`;
  const routes = {
    'POST /v1/auth/login': (init) => {
      const who = JSON.parse(init.body).email === 'smoke@example.com' ? 'owner' : 'other';
      return json(200, {
        accessToken: who,
        refreshToken: `${who}-refresh-0`,
        accessTokenExpiresIn: 900,
      });
    },
    'POST /v1/auth/refresh': (init) => {
      const [who, , n] = JSON.parse(init.body).refreshToken.split('-');
      return json(200, {
        accessToken: who,
        refreshToken: `${who}-refresh-${Number(n) + 1}`,
        accessTokenExpiresIn: 900,
      });
    },
    'POST /v1/sessions': (init) =>
      json(201, { id: SESSION_ID, notes: JSON.parse(init.body).notes }),
    'POST /v1/members/me/export': () => json(202, { jobId: JOB_ID }),
    [`GET /v1/members/me/export/${JOB_ID}`]: (init) => {
      if (init.headers.authorization !== 'Bearer owner') return json(404, {});
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return json(200, {
        jobId: JOB_ID,
        status,
        completedAt: status === 'completed' ? NOW.toISOString() : null,
        error: status === 'failed' ? 'exports_bucket_missing' : null,
        downloadUrl: status === 'completed' ? downloadUrl : null,
        downloadExpiresAt: status === 'completed' ? new Date(EXP * 1000).toISOString() : null,
      });
    },
    [`GET /v1/members/me/export/${JOB_ID}/download`]: (init, url) => {
      if (!init.headers.authorization) return json(401, {});
      const { searchParams } = new URL(url);
      if (searchParams.get('sig') !== 'goodsig' || searchParams.get('exp') !== String(EXP)) {
        return json(403, {});
      }
      if (init.headers.authorization !== 'Bearer owner') return json(404, {});
      return new Response(zip(archiveEntries()), {
        status: 200,
        headers: { 'content-type': 'application/zip', 'cache-control': 'private, no-store' },
      });
    },
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    calls.push({ key, url, init });
    const handler = routes[key];
    return handler ? handler(init, url) : json(404, {});
  };
  return { calls, fetchImpl };
}

const flow = {
  baseUrl: BASE,
  email: 'smoke@example.com',
  password: 'secret',
  otherEmail: 'other@example.com',
  otherPassword: 'secret2',
  studioSlug: 'smoke-studio',
  runId: 'run-1',
  now: () => NOW,
  sleep: async () => {},
  log: () => {},
};

describe('runExportFlow', () => {
  it('requests, polls, downloads, validates and proves access control', async () => {
    const { calls, fetchImpl } = fakeApi();
    const result = await runExportFlow({ ...flow, fetchImpl });

    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.jobId, JOB_ID);
    const polls = calls.filter((c) => c.key === `GET /v1/members/me/export/${JOB_ID}`);
    assert.equal(polls.length, 4); // pending, running, completed, other-account probe
    const downloads = calls.filter((c) => c.key.endsWith('/download'));
    assert.equal(downloads.length, 6);
    assert.ok(
      calls.find((c) => c.key === 'POST /v1/members/me/export').init.headers['idempotency-key'],
    );
  });

  it('fails when the job does not complete before the timeout', async () => {
    let t = NOW.getTime();
    const { fetchImpl } = fakeApi({ statuses: ['pending'] });
    const result = await runExportFlow({
      ...flow,
      fetchImpl,
      jobTimeoutMs: 20_000,
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /still pending after 20 s/);
  });

  it('fails with the stored reason when the job fails', async () => {
    const { fetchImpl } = fakeApi({ statuses: ['failed'] });
    const result = await runExportFlow({ ...flow, fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /exports_bucket_missing/);
  });

  it('fails when another account can download the archive', async () => {
    const api = fakeApi();
    const owner = `GET /v1/members/me/export/${JOB_ID}/download`;
    const { fetchImpl } = fakeApi({
      overrides: {
        [owner]: (init, url) => {
          if (init.headers.authorization === 'Bearer other') {
            return new Response(zip(archiveEntries()), { status: 200 });
          }
          return api.fetchImpl(url, init);
        },
      },
    });
    const result = await runExportFlow({ ...flow, fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /other account: expected 403\/404, got 200/);
  });

  for (const [name, isMutation] of [
    ['tampered signature', (q) => q.get('sig') !== 'goodsig'],
    ['past expiry', (q) => Number(q.get('exp')) < NOW_SEC],
    ['stretched expiry', (q) => Number(q.get('exp')) > EXP],
  ]) {
    it(`fails when a link with a ${name} is still served`, async () => {
      const api = fakeApi();
      const download = `GET /v1/members/me/export/${JOB_ID}/download`;
      const { fetchImpl } = fakeApi({
        overrides: {
          [download]: (init, url) =>
            init.headers.authorization === 'Bearer owner' && isMutation(new URL(url).searchParams)
              ? new Response(zip(archiveEntries()), { status: 200 })
              : api.fetchImpl(url, init),
        },
      });
      const result = await runExportFlow({ ...flow, fetchImpl });
      assert.equal(result.ok, false);
      assert.equal(result.error, `download with ${name}: expected 403, got 200`);
    });
  }

  it('refreshes the access tokens when the job outlives them', async () => {
    let t = NOW.getTime();
    const { calls, fetchImpl } = fakeApi({
      statuses: [...Array.from({ length: 40 }, () => 'running'), 'completed'],
    });
    const result = await runExportFlow({
      ...flow,
      fetchImpl,
      jobTimeoutMs: 30 * 60_000,
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
      pollIntervalMs: 30_000,
    });
    assert.equal(result.error, undefined);
    const refreshes = calls.filter((c) => c.key === 'POST /v1/auth/refresh');
    assert.ok(refreshes.length >= 2, `expected refreshes, got ${refreshes.length}`);
    assert.deepEqual(JSON.parse(refreshes[0].init.body), { refreshToken: 'owner-refresh-0' });
  });

  it('logs the other account in with its own Turnstile token', async () => {
    const { calls, fetchImpl } = fakeApi();
    await runExportFlow({
      ...flow,
      fetchImpl,
      turnstileToken: 'tok-owner',
      otherTurnstileToken: 'tok-other',
    });
    const logins = calls.filter((c) => c.key === 'POST /v1/auth/login');
    assert.deepEqual(
      logins.map((c) => c.init.headers['cf-turnstile-token']),
      ['tok-owner', 'tok-other'],
    );
  });

  it('reports the 24 h rate limit explicitly', async () => {
    const { fetchImpl } = fakeApi({
      overrides: { 'POST /v1/members/me/export': () => json(429, {}) },
    });
    const result = await runExportFlow({ ...flow, fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /rate limited .* --job-id/);
  });

  it('validates an existing job without logging a probe or requesting an export', async () => {
    const { calls, fetchImpl } = fakeApi({ statuses: ['completed'] });
    const result = await runExportFlow({ ...flow, fetchImpl, jobId: JOB_ID });
    assert.equal(result.ok, true);
    assert.equal(calls.filter((c) => c.key.startsWith('POST /v1/sessions')).length, 0);
    assert.equal(calls.filter((c) => c.key === 'POST /v1/members/me/export').length, 0);
  });

  it('never sends the bearer token to a download link on another origin', async () => {
    const { calls, fetchImpl } = fakeApi({
      overrides: {
        [`GET /v1/members/me/export/${JOB_ID}`]: (init) =>
          init.headers.authorization !== 'Bearer owner'
            ? json(404, {})
            : json(200, {
                status: 'completed',
                completedAt: NOW.toISOString(),
                downloadUrl: `https://evil.example/v1/members/me/export/${JOB_ID}/download?exp=${EXP}&sig=x`,
                downloadExpiresAt: new Date(EXP * 1000).toISOString(),
              }),
      },
    });
    const result = await runExportFlow({ ...flow, fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.error, /not the API origin/);
    assert.ok(!calls.some((c) => new URL(c.url).origin === 'https://evil.example'));
  });
});
