/**
 * k6 load test — POST /v1/reservations (book-class hot path)
 *
 * Issue #414 rewrite: exercises concurrent DISTINCT users so repeated
 * calls do not collapse into 409 duplicate-booking responses that
 * mask real capacity-guard behavior.
 *
 * Multi-user protocol
 * -------------------
 * Set K6_AUTH_TOKENS to a comma-separated list of JWTs (one per
 * simulated user). Each VU selects a token by index
 * (`tokens[(__VU - 1) % tokens.length]`) so traffic spreads across
 * all provided identities. Provide ≥ maxVUs tokens for full isolation.
 * K6_AUTH_TOKEN (singular, legacy) is accepted as a single-element
 * list and produces a warning.
 *
 * Metrics breakdown
 * -----------------
 * booking_confirmed_ms — latency of 201 confirmed responses
 * booking_waitlisted_ms — latency of 202 waitlisted responses
 * duplicate_rate — fraction of requests returning 409 (already-booked)
 * rate_limited_rate — fraction returning 429
 * errors — fraction of requests returning 5xx or network error
 *
 * The http_req_failed threshold is DISABLED (set to 100%) because
 * 409 and 429 are intentionally accepted outcomes. SLO gates use
 * booking_confirmed_ms and booking_waitlisted_ms instead.
 *
 * Scenarios
 * ---------
 * nominal_load — 100 req/s for 60 s (default, PR CI)
 * soak         — 50 VUs sustained for 30 min (production gate)
 * spike        — 200 VU burst for 60 s (regression check)
 *
 * Environment variables
 * ---------------------
 * K6_BASE_URL           URL of the API gateway (default: http://localhost:8787)
 * K6_AUTH_TOKENS        CSV of JWTs for distinct test users
 * K6_AUTH_TOKEN         Single JWT — legacy fallback, triggers a warning
 * K6_STUDIO_ID          UUID v4 of the target studio
 * K6_CLASS_IDS          CSV of class UUIDs to spread booking traffic across
 * K6_SCENARIO           Which scenario to run (nominal_load | soak | spike)
 *
 * Usage
 *   export K6_BASE_URL=https://staging.api.athlya.app
 *   export K6_AUTH_TOKENS=eyJ...,eyJ...,eyJ...
 *   export K6_STUDIO_ID=22222222-...
 *   export K6_CLASS_IDS=class-1,class-2,...
 *   k6 run k6/book-class.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const confirmedDuration = new Trend('booking_confirmed_ms', true);
const waitlistedDuration = new Trend('booking_waitlisted_ms', true);
const duplicateRate = new Rate('duplicate_rate');
const rateLimitedRate = new Rate('rate_limited_rate');
const errorRate = new Rate('errors');

const SCENARIO = __ENV.K6_SCENARIO ?? 'nominal_load';

const SCENARIOS = {
  nominal_load: {
    executor: 'constant-arrival-rate',
    rate: 100,
    timeUnit: '1s',
    duration: '60s',
    preAllocatedVUs: 50,
    maxVUs: 200,
  },
  soak: {
    executor: 'constant-vus',
    vus: 50,
    duration: '30m',
  },
  spike: {
    executor: 'constant-arrival-rate',
    rate: 200,
    timeUnit: '1s',
    duration: '60s',
    preAllocatedVUs: 200,
    maxVUs: 400,
  },
};

if (!(SCENARIO in SCENARIOS)) {
  throw new Error(
    `Unknown K6_SCENARIO "${SCENARIO}". Valid values: ${Object.keys(SCENARIOS).join(', ')}`,
  );
}

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  thresholds: {
    // SLO S1: p99 < 500 ms on real bookings (201 confirmed, 202 waitlisted).
    booking_confirmed_ms: ['p(99)<500'],
    booking_waitlisted_ms: ['p(99)<500'],
    // SLO S3: 5xx error rate < 0.1%.
    errors: ['rate<0.001'],
    // Duplicate and rate-limit rates are informational; fail if unexpectedly
    // high (>50% duplicate → tokens list too short; >5% rate-limited → burst
    // profile needs tuning).
    duplicate_rate: ['rate<0.5'],
    rate_limited_rate: ['rate<0.05'],
    // http_req_failed is disabled — 409/429 are accepted outcomes and would
    // trip the default threshold. SLO is enforced via per-outcome metrics.
    http_req_failed: ['rate<1.0'],
  },
};

const BASE_URL = __ENV.K6_BASE_URL ?? 'http://localhost:8787';
const STUDIO_ID = __ENV.K6_STUDIO_ID ?? '';
const CLASS_IDS = (__ENV.K6_CLASS_IDS ?? '').split(',').filter(Boolean);

// Multi-user token selection. K6_AUTH_TOKENS (plural) is the canonical
// form. K6_AUTH_TOKEN (singular) is accepted for backward compatibility.
const RAW_TOKENS = __ENV.K6_AUTH_TOKENS ?? __ENV.K6_AUTH_TOKEN ?? '';
const TOKENS = RAW_TOKENS.split(',').filter(Boolean);

export function setup() {
  if (CLASS_IDS.length === 0) {
    throw new Error('K6_CLASS_IDS must be a non-empty CSV of class UUIDs');
  }
  if (TOKENS.length === 0) {
    throw new Error('K6_AUTH_TOKENS (or K6_AUTH_TOKEN) must be set');
  }
  if (TOKENS.length === 1) {
    console.warn(
      '[book-class] K6_AUTH_TOKENS has only one entry — all VUs share the same identity. ' +
        'Provide one token per VU for realistic multi-user contention.',
    );
  }
  return { tokens: TOKENS };
}

export default function (data) {
  // Assign each VU a stable token so repeated iterations of the same
  // VU always represent the same simulated user. This prevents the VU
  // from booking the same class twice (which would return 409) unless
  // it was already waitlisted on a previous iteration.
  const token = data.tokens[(__VU - 1) % data.tokens.length];

  // Spread bookings across the class pool to avoid hammering a single
  // Postgres row and a single Redis counter.
  const classId = CLASS_IDS[Math.floor(Math.random() * CLASS_IDS.length)];

  // Unique idempotency key per (VU, iteration) prevents retry storms
  // from the k6 runner from creating duplicate load — the API's
  // idempotency layer deduplicates at the token level.
  const idemKey = `k6-${__VU}-${__ITER}`;

  const res = http.post(
    `${BASE_URL}/v1/reservations`,
    JSON.stringify({ classId, studioId: STUDIO_ID }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': idemKey,
      },
      tags: { name: 'book_class' },
    },
  );

  const is5xx = res.status >= 500;
  const is409 = res.status === 409;
  const is429 = res.status === 429;

  check(res, {
    'no 5xx': (r) => r.status < 500,
    'accepted status': (r) =>
      r.status === 201 || r.status === 202 || r.status === 409 || r.status === 429,
  });

  errorRate.add(is5xx ? 1 : 0);
  duplicateRate.add(is409 ? 1 : 0);
  rateLimitedRate.add(is429 ? 1 : 0);

  if (res.status === 201) confirmedDuration.add(res.timings.duration);
  if (res.status === 202) waitlistedDuration.add(res.timings.duration);

  sleep(0.05);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    'k6-book-class-summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const pct = (v) => ((v ?? 0) * 100).toFixed(2) + '%';
  const ms = (key, p) => (m[key]?.values?.[`p(${p})`] ?? 0).toFixed(0) + ' ms';
  const lines = [
    '',
    'Athlya — book-class load test summary',
    '──────────────────────────────────────',
    `requests:          ${m.http_reqs?.values?.count ?? 0}`,
    `5xx errors:        ${pct(m.errors?.values?.rate)}  (SLO < 0.1%)`,
    `duplicates (409):  ${pct(m.duplicate_rate?.values?.rate)}  (warn > 50%)`,
    `rate-limited (429):${pct(m.rate_limited_rate?.values?.rate)}  (warn > 5%)`,
    '',
    'confirmed (201)',
    `  p50: ${ms('booking_confirmed_ms', 50)}  p95: ${ms('booking_confirmed_ms', 95)}  p99: ${ms('booking_confirmed_ms', 99)}  (SLO p99 < 500 ms)`,
    '',
    'waitlisted (202)',
    `  p50: ${ms('booking_waitlisted_ms', 50)}  p95: ${ms('booking_waitlisted_ms', 95)}  p99: ${ms('booking_waitlisted_ms', 99)}  (SLO p99 < 500 ms)`,
    '',
  ];
  return lines.join('\n');
}
