/**
 * k6 load test — GET /v1/classes
 *
 * Sprint 14 / Slice 14.2 (Epic CN.2.2).
 *
 * Profile : 200 req/s pendant 60s. Read-heavy endpoint — un
 * studio actif voit son listing scrollé toutes les minutes par
 * 10-20 utilisateurs concurrents.
 *
 * Algorithme exercé :
 *   - Drizzle SELECT range-bounded sur `classes`
 *   - `Promise.all(rows.map(counter.getRemaining))` → fan-out
 *     Redis GET sur chaque counter
 *   - ETag computation + Cache-Control headers
 *
 * SLO S5 : p95 < 100ms (avec 304 Not Modified souvent). On
 * cible plus large que S1 parce que le listing peut tomber dans
 * le case Postgres seq-scan si l'index `class_studio_starts_at`
 * est manquant.
 *
 * Pré-requis :
 *   - K6_BASE_URL, K6_AUTH_TOKEN, K6_STUDIO_ID (cf
 *     `book-class.js`)
 *
 * Usage CI : workflow `.github/workflows/load-test.yml`.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    nominal_read: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    // SLO S5 (informatif).
    'http_req_duration{status:200,name:list_classes}': ['p(95)<100'],
    'http_req_duration{status:304,name:list_classes}': ['p(95)<50'],
    errors: ['rate<0.001'],
  },
};

const BASE_URL = __ENV.K6_BASE_URL ?? 'http://localhost:8787';
const AUTH_TOKEN = __ENV.K6_AUTH_TOKEN ?? '';

// Stash an ETag from the first iteration so subsequent calls
// exercise the 304 fast path. k6 has no cross-iteration shared
// state by default; per-VU state is fine here because we want
// each VU to flip between "first call → 200" and "subsequent →
// 304".
let cachedEtag = '';

export default function () {
  const headers = {
    authorization: `Bearer ${AUTH_TOKEN}`,
    accept: 'application/json',
  };
  if (cachedEtag !== '') {
    headers['if-none-match'] = cachedEtag;
  }

  // Date range : the next 7 days. Realistic for a member
  // checking what to book this week.
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();

  const res = http.get(`${BASE_URL}/v1/classes?from=${from}&to=${to}`, {
    headers,
    tags: { name: 'list_classes' },
  });

  const ok = check(res, {
    'status 200 or 304': (r) => r.status === 200 || r.status === 304,
    'no 5xx': (r) => r.status < 500,
  });

  if (res.status === 200) {
    cachedEtag = res.headers['Etag'] ?? cachedEtag;
  }

  errorRate.add(ok ? 0 : 1);
  sleep(0.025);
}
