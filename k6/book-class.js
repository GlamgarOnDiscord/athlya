/**
 * k6 load test — POST /v1/reservations/book
 *
 * Sprint 14 / Slice 14.2 (Epic CN.2.1).
 *
 * Profile : 100 req/s pendant 60s. C'est le throughput nominal
 * d'un studio de 500 membres au pic horaire (sortie de cours)
 * lorsque tout le monde rebook simultanément.
 *
 * Algorithme exercé : Redis DECR sur le counter `class:cap:<classId>`
 * + Neon `FOR UPDATE` sur la row `classes` + insert outbox
 * transactional. C'est le hot path le plus contention-critical du
 * système — le SLO S1 (p99 < 500ms) y est mesuré.
 *
 * Pré-requis :
 *   - K6_BASE_URL : URL du gateway (ex: `https://staging.api.athlya.app`)
 *   - K6_AUTH_TOKEN : JWT valide pour un user du studio cible
 *   - K6_STUDIO_ID : UUID v4 du studio
 *   - K6_CLASS_IDS : CSV d'UUIDs de classes (10+ recommandé pour
 *     éviter de hammerer la même row Postgres)
 *
 * Usage local :
 *
 *     export K6_BASE_URL=https://staging.api.athlya.app
 *     export K6_AUTH_TOKEN=eyJ...
 *     export K6_STUDIO_ID=22222222-...
 *     export K6_CLASS_IDS=class-1,class-2,class-3
 *     k6 run k6/book-class.js
 *
 * Usage CI : voir `.github/workflows/load-test.yml`. Le workflow
 * fait fail le build si p99 > 500ms (SLO S1).
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics — surfacent le breakdown success/error pour le
// dashboard k6 cloud + Grafana.
const errorRate = new Rate('errors');
const bookingDuration = new Trend('booking_duration_ms', true);
// Per-outcome duration trends so the SLO threshold covers real
// successes (201 confirmed, 202 waitlisted) independently.
const confirmedDuration = new Trend('booking_confirmed_ms', true);
const waitlistedDuration = new Trend('booking_waitlisted_ms', true);

export const options = {
  scenarios: {
    nominal_load: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    // SLO S1 : p99 < 500ms on successful bookings (201 confirmed,
    // 202 waitlisted). Previously measured on status:200 which
    // excluded all real successes — fixed by issue #304.
    booking_confirmed_ms: ['p(99)<500'],
    booking_waitlisted_ms: ['p(99)<500'],
    // Error rate < 0.1% (SLO S3).
    errors: ['rate<0.001'],
    // Sanity check : majorité des requests doivent aboutir.
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.K6_BASE_URL ?? 'http://localhost:8787';
const AUTH_TOKEN = __ENV.K6_AUTH_TOKEN ?? '';
const STUDIO_ID = __ENV.K6_STUDIO_ID ?? '';
const CLASS_IDS = (__ENV.K6_CLASS_IDS ?? '').split(',').filter(Boolean);

export function setup() {
  if (CLASS_IDS.length === 0) {
    throw new Error('k6/book-class.js: K6_CLASS_IDS must be set to a CSV of class UUIDs');
  }
}

export default function () {
  // Pick a random class so we are not all hammering the same
  // counter — a real-world booking pattern spreads across many
  // classes per minute.
  const classId = CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];

  // Idempotency key per VU iteration so retries naturally
  // collapse to a single booking — we measure the happy path
  // without an unfair retry storm.
  const idemKey = `k6-${__VU}-${__ITER}-${Date.now()}`;

  const res = http.post(
    `${BASE_URL}/v1/reservations`,
    JSON.stringify({ classId, studioId: STUDIO_ID }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AUTH_TOKEN}`,
        'idempotency-key': idemKey,
        'cf-connecting-ip': `10.${__VU % 256}.${__ITER % 256}.1`,
      },
      tags: { name: 'book_class' },
    },
  );

  const ok = check(res, {
    // 201 = confirmed, 202 = waitlisted, 409 = already booked / full,
    // 429 = rate limited — all expected non-error outcomes.
    // Previously checked for 200 which excluded all real successes.
    'status 201 or 202 or 409 or 429': (r) =>
      r.status === 201 || r.status === 202 || r.status === 409 || r.status === 429,
    'no 5xx': (r) => r.status < 500,
  });

  if (!ok || res.status >= 500) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }

  // Record per-outcome duration so SLO thresholds cover real successes.
  if (res.status === 201) confirmedDuration.add(res.timings.duration);
  if (res.status === 202) waitlistedDuration.add(res.timings.duration);

  bookingDuration.add(res.timings.duration);

  // Tiny sleep to keep VUs from looping at full speed when the
  // arrival rate scheduler oversubscribes them — keeps CPU
  // bounded in CI runners.
  sleep(0.05);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    'k6-book-class-summary.json': JSON.stringify(data, null, 2),
  };
}

// Minimal text summary so CI logs stay readable.
function textSummary(data) {
  const m = data.metrics;
  const lines = [
    '',
    '🏋️  Athlya — book-class load test summary',
    '─────────────────────────────────────────',
    `requests:       ${m.http_reqs?.values?.count ?? 0}`,
    `errors:         ${(m.errors?.values?.rate ?? 0) * 100}%`,
    `p50 duration:   ${m.http_req_duration?.values?.['p(50)'] ?? 0} ms`,
    `p95 duration:   ${m.http_req_duration?.values?.['p(95)'] ?? 0} ms`,
    `p99 duration:   ${m.http_req_duration?.values?.['p(99)'] ?? 0} ms`,
    `slo target:     p99 < 500ms`,
    '',
  ];
  return lines.join('\n');
}
