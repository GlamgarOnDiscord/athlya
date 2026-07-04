/**
 * DO fanout benchmark — ClassCapacityDO WebSocket capacity (issue #423).
 *
 * Measures:
 *   - p95 broadcast latency at CLASS_CAPACITY_MAX_WS (default 500) connections
 *   - Shed behaviour: connections above cap receive 503 + X-Capacity-Fallback: poll
 *   - Recovery: shed count drops when existing connections close
 *
 * Usage:
 *   K6_BASE_URL=https://staging.api.athlya.app \
 *   K6_CLASS_ID=<uuid> \
 *   K6_WS_CAP=500 \
 *   k6 run k6/do-fanout.js
 *
 * The CLASS_ID must have at least 1 confirmed booking so capacity
 * updates are emitted when the booking counter changes.
 *
 * Scenarios:
 *   ramp_to_cap     — ramp to CLASS_CAPACITY_MAX_WS over 2 min, hold 3 min
 *   above_cap       — 50 extra VUs that should receive 503 shed responses
 *   broadcast_storm — simulate concurrent bookings while at cap
 */

import { check, sleep } from 'k6';
import http from 'k6/http';
import ws from 'k6/ws';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.K6_BASE_URL || 'https://staging.api.athlya.app';
const CLASS_ID = __ENV.K6_CLASS_ID || '';
const WS_CAP = parseInt(__ENV.K6_WS_CAP || '500', 10);
const BOOKING_TOKEN = __ENV.K6_BOOKING_TOKEN || '';

if (!CLASS_ID) {
  throw new Error('K6_CLASS_ID is required');
}

const broadcastLatency = new Trend('do_broadcast_latency_ms', true);
const shedRate = new Rate('do_shed_rate');
const updateReceived = new Counter('do_capacity_updates_received');
const connectionsFailed = new Counter('do_connections_failed');

export const options = {
  scenarios: {
    ramp_to_cap: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: WS_CAP },
        { duration: '3m', target: WS_CAP },
        { duration: '30s', target: 0 },
      ],
      tags: { scenario: 'ramp_to_cap' },
    },
    above_cap: {
      executor: 'constant-vus',
      vus: 50,
      duration: '5m30s',
      startTime: '2m',
      tags: { scenario: 'above_cap' },
    },
    broadcast_storm: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 20,
      startTime: '2m',
      exec: 'bookingBurst',
      tags: { scenario: 'broadcast_storm' },
    },
  },
  thresholds: {
    // p95 broadcast latency must stay under 500 ms at cap.
    do_broadcast_latency_ms: ['p(95)<500'],
    // Shed rate for above-cap connections should be near 100%.
    // The threshold is that shed is detected; false negatives are a failure.
    do_shed_rate: ['rate>0.8'],
    // No unexpected connection failures in the ramp_to_cap scenario.
    do_connections_failed: ['count<10'],
    // HTTP errors from the booking burst should be minimal.
    http_req_failed: ['rate<0.05'],
  },
};

/**
 * Default scenario: open a WebSocket connection and listen for capacity_update
 * messages. Measures the round-trip from connect to first update.
 */
export default function () {
  const url = `${BASE_URL.replace(/^http/, 'ws')}/v1/classes/${CLASS_ID}/capacity/ws`;

  const connectStart = Date.now();
  let firstUpdateReceived = false;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', () => {
      // Connection established — wait for updates.
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'capacity_update') {
          if (!firstUpdateReceived) {
            broadcastLatency.add(Date.now() - connectStart);
            firstUpdateReceived = true;
          }
          updateReceived.add(1);
        }
      } catch {
        // Non-JSON message (ping/pong frames) — ignore.
      }
    });

    socket.on('error', (e) => {
      connectionsFailed.add(1);
    });

    // Hold connection for up to 30 s, then close.
    socket.setTimeout(function () {
      socket.close();
    }, 30_000);
  });

  // 503 = DO shed response
  const wasShed = res.status === 503;
  shedRate.add(wasShed ? 1 : 0);

  check(res, {
    'connected or shed (no unexpected error)': (r) => r.status === 101 || r.status === 503,
    'shed response has X-Capacity-Fallback header': (r) =>
      r.status !== 503 || r.headers['X-Capacity-Fallback'] === 'poll',
  });

  sleep(1);
}

/**
 * broadcast_storm scenario: POST a booking to trigger a capacity_update
 * broadcast to all connected sockets. Measures booking success rate under load.
 */
export function bookingBurst() {
  if (!BOOKING_TOKEN) return;

  const res = http.post(`${BASE_URL}/v1/classes/${CLASS_ID}/book`, JSON.stringify({}), {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BOOKING_TOKEN}`,
    },
    tags: { name: 'booking_burst' },
  });

  check(res, {
    'booking accepted or rejected gracefully': (r) =>
      r.status === 201 || r.status === 409 || r.status === 429,
  });
}

export function handleSummary(data) {
  const latencyP95 = data.metrics['do_broadcast_latency_ms']?.values?.['p(95)'] ?? 'N/A';
  const shed = data.metrics['do_shed_rate']?.values?.rate ?? 0;
  const updates = data.metrics['do_capacity_updates_received']?.values?.count ?? 0;
  const failed = data.metrics['do_connections_failed']?.values?.count ?? 0;

  const summary = [
    '',
    '== DO Fanout Benchmark Summary ==',
    `  p95 broadcast latency : ${typeof latencyP95 === 'number' ? latencyP95.toFixed(1) + ' ms' : latencyP95}`,
    `  shed rate (above cap) : ${(shed * 100).toFixed(1)}%`,
    `  capacity_update events: ${updates}`,
    `  connection failures   : ${failed}`,
    `  WS cap tested         : ${WS_CAP}`,
    '',
    'Acceptance criteria:',
    `  p95 latency < 500 ms  : ${typeof latencyP95 === 'number' && latencyP95 < 500 ? 'PASS' : 'FAIL'}`,
    `  shed detected (>80%)  : ${shed > 0.8 ? 'PASS' : 'FAIL'}`,
    `  connection failures   : ${failed < 10 ? 'PASS' : 'FAIL'}`,
    '',
  ].join('\n');

  console.log(summary);

  return {
    stdout: summary,
  };
}
