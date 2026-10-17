import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_MAX_P95_MS,
  DEFAULT_SAMPLES,
  evaluateLatency,
  percentile,
  probeCanaryLatency,
  readLatencyConfig,
} from '../canary-latency.mjs';

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(values, 95), 19);
    assert.equal(percentile(values, 100), 20);
    assert.equal(percentile([7], 95), 7);
  });

  it('is NaN for no samples', () => {
    assert.ok(Number.isNaN(percentile([], 95)));
  });
});

describe('evaluateLatency', () => {
  it('passes at the threshold and fails above it', () => {
    assert.equal(evaluateLatency({ p95Ms: 1500, maxP95Ms: 1500 }).ok, true);
    assert.equal(evaluateLatency({ p95Ms: 1501, maxP95Ms: 1500 }).ok, false);
  });

  it('fails closed when the latency is unavailable', () => {
    assert.equal(evaluateLatency({ p95Ms: Number.NaN, maxP95Ms: 1500 }).ok, false);
  });
});

describe('readLatencyConfig', () => {
  it('defaults unset and empty values', () => {
    for (const env of [{}, { CANARY_MAX_P95_MS: '', CANARY_LATENCY_SAMPLES: '' }]) {
      assert.deepEqual(readLatencyConfig(env), {
        ok: true,
        config: { maxP95Ms: DEFAULT_MAX_P95_MS, samples: DEFAULT_SAMPLES },
      });
    }
  });

  it('accepts integers in range', () => {
    const result = readLatencyConfig({ CANARY_MAX_P95_MS: '800', CANARY_LATENCY_SAMPLES: '50' });
    assert.deepEqual(result, { ok: true, config: { maxP95Ms: 800, samples: 50 } });
  });

  it('rejects malformed or out-of-range values instead of falling back', () => {
    for (const env of [
      { CANARY_MAX_P95_MS: 'abc' },
      { CANARY_MAX_P95_MS: '0' },
      { CANARY_MAX_P95_MS: '1.5' },
      { CANARY_LATENCY_SAMPLES: '2' },
      { CANARY_LATENCY_SAMPLES: '-5' },
    ]) {
      assert.equal(readLatencyConfig(env).ok, false, JSON.stringify(env));
    }
  });
});

describe('probeCanaryLatency', () => {
  const base = {
    baseUrl: 'https://api.example.test/',
    workerName: 'athlya-api-production',
    versionId: 'v-123',
    expectedVersion: 'abc1234',
    samples: 5,
  };

  function clock(stepMs) {
    let t = 0;
    let calls = 0;
    return () => {
      calls += 1;
      if (calls % 2 === 0) t += stepMs;
      return t;
    };
  }

  it('pins every request to the canary and reports the p95', async () => {
    const seen = [];
    const result = await probeCanaryLatency({
      ...base,
      now: clock(100),
      fetchImpl: async (url, init) => {
        seen.push({ url, override: init.headers['cloudflare-workers-version-overrides'] });
        return new Response(JSON.stringify({ status: 'ready', version: 'abc1234' }));
      },
    });
    assert.equal(seen.length, 5);
    for (const request of seen) {
      assert.equal(request.url, 'https://api.example.test/health/ready');
      assert.equal(request.override, 'athlya-api-production="v-123"');
    }
    assert.deepEqual(result.failures, []);
    assert.equal(result.p95Ms, 100);
  });

  it('fails closed when a sample is served by another version', async () => {
    let n = 0;
    const result = await probeCanaryLatency({
      ...base,
      fetchImpl: async () => {
        n += 1;
        const version = n === 3 ? 'old0000' : 'abc1234';
        return new Response(JSON.stringify({ status: 'ready', version }));
      },
    });
    assert.ok(Number.isNaN(result.p95Ms));
    assert.match(result.failures[0], /old0000/);
  });

  it('fails closed on a non-ready answer or a network error', async () => {
    const notReady = await probeCanaryLatency({
      ...base,
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: 'not_ready', version: 'abc1234' }), { status: 503 }),
    });
    assert.ok(Number.isNaN(notReady.p95Ms));

    const down = await probeCanaryLatency({
      ...base,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    assert.ok(Number.isNaN(down.p95Ms));
    assert.equal(down.failures.length, 5);
  });
});
