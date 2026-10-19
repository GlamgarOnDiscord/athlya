/**
 * Unit tests for the device attestation middleware (issue #659).
 *
 * Every provider call goes through an injected `fetch`; RSA / P-256
 * keys are generated per run so no credential is checked in.
 */

import { generateKeyPairSync } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  APPLE_DEVICECHECK_URLS,
  DEVICE_ATTESTATION_PLATFORM_HEADER,
  DEVICE_ATTESTATION_TOKEN_HEADER,
  GOOGLE_OAUTH_TOKEN_URL,
  PLAY_INTEGRITY_API_BASE,
  computeAttestationRequestHash,
  deviceAttestation,
  evaluatePlayIntegrityPayload,
  resolveDeviceAttestationMode,
  type CredentialCache,
  type DeviceAttestationContext,
  type DeviceAttestationEnv,
} from '../middleware/device-attestation.js';

import { readJson } from './helpers/read-json.js';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const PACKAGE = 'app.athlya.mobile';
const TURNSTILE_TOKEN = 'turnstile-token-abc';
const DECODE_URL = `${PLAY_INTEGRITY_API_BASE}/${PACKAGE}:decodeIntegrityToken`;

let rsaPem = '';
let ecPem = '';

beforeAll(() => {
  rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  ecPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
});

function serviceAccountJson(): string {
  return JSON.stringify({
    type: 'service_account',
    client_email: 'integrity@athlya-test.iam.gserviceaccount.com',
    private_key: rsaPem,
    token_uri: 'https://attacker.invalid/token',
  });
}

type EnvOverrides = { readonly [K in keyof DeviceAttestationEnv]?: string | undefined };

function withOverrides(base: DeviceAttestationEnv, overrides: EnvOverrides): DeviceAttestationEnv {
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as unknown as DeviceAttestationEnv;
}

function androidEnv(overrides: EnvOverrides = {}): DeviceAttestationEnv {
  return withOverrides(
    {
      ENVIRONMENT: 'staging',
      DEVICE_ATTESTATION_MODE: 'report',
      PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
    },
    overrides,
  );
}

function iosEnv(overrides: EnvOverrides = {}): DeviceAttestationEnv {
  return withOverrides(
    {
      ENVIRONMENT: 'staging',
      DEVICE_ATTESTATION_MODE: 'report',
      APPLE_DEVICECHECK_TEAM_ID: 'TEAM123456',
      APPLE_DEVICECHECK_KEY_ID: 'KEY1234567',
      APPLE_DEVICECHECK_PRIVATE_KEY: ecPem,
    },
    overrides,
  );
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeContext(env: DeviceAttestationEnv, headers: Record<string, string>) {
  const logger = fakeLogger();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const c: DeviceAttestationContext = {
    env,
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) => (key === 'logger' ? logger : 'trace-1'),
    body: (data, status, h) => new Response(data, { status, headers: h }),
  };
  return { c, logger };
}

function attestationHeaders(platform: string, token = 'integrity-token') {
  return {
    'cf-turnstile-token': TURNSTILE_TOKEN,
    [DEVICE_ATTESTATION_PLATFORM_HEADER]: platform,
    [DEVICE_ATTESTATION_TOKEN_HEADER]: token,
  };
}

async function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestDetails: {
      requestPackageName: PACKAGE,
      requestHash: await computeAttestationRequestHash('login', TURNSTILE_TOKEN),
      timestampMillis: String(NOW - 10_000),
    },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: PACKAGE },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
    ...overrides,
  };
}

/** 200 response whose body sends one chunk and then never ends. */
function stalledBodyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"tokenPayloadExternal":'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function googleFetch(decode: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url === GOOGLE_OAUTH_TOKEN_URL) {
      return Promise.resolve(Response.json({ access_token: 'ya29.test', expires_in: 3600 }));
    }
    if (url === DECODE_URL) return Promise.resolve(decode());
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

async function run(
  env: DeviceAttestationEnv,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  extra: { action?: 'login' | 'register'; cache?: CredentialCache; timeoutMs?: number } = {},
) {
  const mw = deviceAttestation(extra.action ?? 'login', {
    fetch: fetchImpl,
    now: () => NOW,
    credentialCache: extra.cache ?? new Map(),
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
  });
  const { c, logger } = fakeContext(env, headers);
  const next = vi.fn(() => Promise.resolve());
  const res = await mw(c, next);
  return { res, next, logger };
}

function verdictLog(logger: ReturnType<typeof fakeLogger>) {
  const calls = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls];
  const call = calls.find(([msg]) => msg === 'device attestation verdict');
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('resolveDeviceAttestationMode', () => {
  it('defaults to off for unset and unknown values', () => {
    expect(resolveDeviceAttestationMode(undefined)).toBe('off');
    expect(resolveDeviceAttestationMode('')).toBe('off');
    expect(resolveDeviceAttestationMode('enforced')).toBe('off');
    expect(resolveDeviceAttestationMode(' Report ')).toBe('report');
    expect(resolveDeviceAttestationMode('enforce')).toBe('enforce');
  });
});

describe('computeAttestationRequestHash', () => {
  it('is a 43-char base64url digest bound to the action and the Turnstile token', async () => {
    const login = await computeAttestationRequestHash('login', 'tok');
    expect(login).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await computeAttestationRequestHash('register', 'tok')).not.toBe(login);
    expect(await computeAttestationRequestHash('login', 'tok2')).not.toBe(login);
  });
});

describe('evaluatePlayIntegrityPayload', () => {
  const base = { packageName: PACKAGE, nowMs: NOW, maxTokenAgeMs: 300_000, clockSkewMs: 60_000 };

  it('passes a genuine, fresh, request-bound verdict', async () => {
    const payload = await validPayload();
    const verdict = evaluatePlayIntegrityPayload(payload, {
      ...base,
      requestHash: payload.requestDetails.requestHash,
    });
    expect(verdict.outcome).toBe('pass');
    expect(verdict.reasons).toEqual([]);
  });

  it('flags a replayed token whose hash belongs to another request', async () => {
    const verdict = evaluatePlayIntegrityPayload(await validPayload(), {
      ...base,
      requestHash: await computeAttestationRequestHash('login', 'other-turnstile'),
    });
    expect(verdict.outcome).toBe('fail');
    expect(verdict.reasons).toContain('request_hash_mismatch');
  });

  it('flags stale and future timestamps', async () => {
    const payload = await validPayload();
    const hash = payload.requestDetails.requestHash;
    const stale = evaluatePlayIntegrityPayload(
      { ...payload, requestDetails: { ...payload.requestDetails, timestampMillis: NOW - 301_000 } },
      { ...base, requestHash: hash },
    );
    expect(stale.reasons).toEqual(['token_stale']);
    const skewed = evaluatePlayIntegrityPayload(
      { ...payload, requestDetails: { ...payload.requestDetails, timestampMillis: NOW + 30_000 } },
      { ...base, requestHash: hash },
    );
    expect(skewed.outcome).toBe('pass');
    const future = evaluatePlayIntegrityPayload(
      { ...payload, requestDetails: { ...payload.requestDetails, timestampMillis: NOW + 61_000 } },
      { ...base, requestHash: hash },
    );
    expect(future.reasons).toEqual(['timestamp_in_future']);
  });

  it('flags unrecognized apps, other packages and weak device integrity', async () => {
    const payload = await validPayload({
      appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION', packageName: 'evil.app' },
      deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] },
    });
    const verdict = evaluatePlayIntegrityPayload(
      {
        ...payload,
        requestDetails: { ...(payload.requestDetails as object), requestPackageName: 'evil.app' },
      },
      { ...base, requestHash: (await validPayload()).requestDetails.requestHash },
    );
    expect(verdict.reasons).toEqual([
      'package_mismatch',
      'app_not_recognized',
      'app_package_mismatch',
      'device_integrity',
    ]);
  });
});

describe('deviceAttestation middleware — off and absent', () => {
  it('makes no outbound call and calls next() when the mode is unset', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { res, next, logger } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: undefined }),
      attestationHeaders('android'),
      fetchImpl,
    );
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('lets a request without attestation headers through, even in enforce mode', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { res, next, logger } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: 'enforce' }),
      { 'cf-turnstile-token': TURNSTILE_TOKEN },
      fetchImpl,
    );
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'device attestation absent',
      expect.objectContaining({ mode: 'enforce', action: 'login' }),
    );
  });
});

describe('deviceAttestation middleware — Android (Play Integrity)', () => {
  it('report: decodes the token with a pinned OAuth endpoint and logs a pass', async () => {
    const fetchImpl = googleFetch(async () =>
      Response.json({ tokenPayloadExternal: await validPayload() }),
    );
    const { res, next, logger } = await run(androidEnv(), attestationHeaders('android'), fetchImpl);

    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'pass',
      platform: 'android',
      requestBound: true,
    });
    const urls = fetchImpl.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual([GOOGLE_OAUTH_TOKEN_URL, DECODE_URL]);
    const decodeInit = fetchImpl.mock.calls[1]?.[1];
    expect(new Headers(decodeInit?.headers).get('authorization')).toBe('Bearer ya29.test');
    expect(JSON.parse(String(decodeInit?.body))).toEqual({ integrity_token: 'integrity-token' });
  });

  it('never logs the attestation token or the request hash', async () => {
    const fetchImpl = googleFetch(async () =>
      Response.json({ tokenPayloadExternal: await validPayload() }),
    );
    const { logger } = await run(
      androidEnv(),
      attestationHeaders('android', 'SECRET-TOKEN'),
      fetchImpl,
    );
    const hash = await computeAttestationRequestHash('login', TURNSTILE_TOKEN);
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    expect(logged).not.toContain('SECRET-TOKEN');
    expect(logged).not.toContain(hash);
  });

  it('reuses the cached Google access token across requests', async () => {
    const fetchImpl = googleFetch(async () =>
      Response.json({ tokenPayloadExternal: await validPayload() }),
    );
    const cache: CredentialCache = new Map();
    await run(androidEnv(), attestationHeaders('android'), fetchImpl, { cache });
    await run(androidEnv(), attestationHeaders('android'), fetchImpl, { cache });
    const oauthCalls = fetchImpl.mock.calls.filter(([i]) => String(i) === GOOGLE_OAUTH_TOKEN_URL);
    expect(oauthCalls).toHaveLength(1);
  });

  it('binds to the route: a login token presented on register fails the hash check', async () => {
    const fetchImpl = googleFetch(async () =>
      Response.json({ tokenPayloadExternal: await validPayload() }),
    );
    const { logger } = await run(androidEnv(), attestationHeaders('android'), fetchImpl, {
      action: 'register',
    });
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'fail',
      reasons: ['request_hash_mismatch'],
    });
  });

  it('enforce: answers 403 device_attestation_failed on a failing verdict', async () => {
    const fetchImpl = googleFetch(async () =>
      Response.json({
        tokenPayloadExternal: await validPayload({
          deviceIntegrity: { deviceRecognitionVerdict: [] },
        }),
      }),
    );
    const { res, next } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: 'enforce' }),
      attestationHeaders('android'),
      fetchImpl,
    );
    expect(res?.status).toBe(403);
    expect(res?.headers.get('content-type')).toBe('application/problem+json');
    expect(await readJson<{ code: string }>(res as Response)).toMatchObject({
      code: 'device_attestation_failed',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('enforce: answers 403 when Google rejects the token (400)', async () => {
    const fetchImpl = googleFetch(() => new Response('{}', { status: 400 }));
    const { res } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: 'enforce' }),
      attestationHeaders('android'),
      fetchImpl,
    );
    expect(res?.status).toBe(403);
  });

  it('report: fails open when Google is down', async () => {
    const fetchImpl = googleFetch(() => new Response('', { status: 503 }));
    const { res, next, logger } = await run(androidEnv(), attestationHeaders('android'), fetchImpl);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'unavailable',
      reasons: ['play_integrity_error'],
      upstreamStatus: 503,
    });
  });

  it('report: fails open on a network error or timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const { res, next, logger } = await run(androidEnv(), attestationHeaders('android'), fetchImpl);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'unavailable',
      reasons: ['provider_network_error'],
    });
  });

  it('report: the timeout also bounds a response body that stalls', async () => {
    const fetchImpl = googleFetch(() => stalledBodyResponse());
    const started = Date.now();
    const { res, next, logger } = await run(
      androidEnv(),
      attestationHeaders('android'),
      fetchImpl,
      {
        timeoutMs: 50,
      },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'unavailable',
      reasons: ['provider_timeout'],
    });
  });

  it('enforce: a stalled response body answers 503', async () => {
    const fetchImpl = googleFetch(() => stalledBodyResponse());
    const { res } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: 'enforce' }),
      attestationHeaders('android'),
      fetchImpl,
      { timeoutMs: 50 },
    );
    expect(res?.status).toBe(503);
  });

  it('report: a malformed decode response is unavailable, not a crash', async () => {
    const fetchImpl = googleFetch(() => new Response('not json', { status: 200 }));
    const { res, logger } = await run(androidEnv(), attestationHeaders('android'), fetchImpl);
    expect(res).toBeUndefined();
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'unavailable',
      reasons: ['play_integrity_malformed'],
    });
  });

  it('enforce: answers 503 when Google is down', async () => {
    const fetchImpl = googleFetch(() => new Response('', { status: 500 }));
    const { res, next } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: 'enforce' }),
      attestationHeaders('android'),
      fetchImpl,
    );
    expect(res?.status).toBe(503);
    expect(await readJson<{ code: string }>(res as Response)).toMatchObject({
      code: 'device_attestation_unavailable',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('report: unconfigured credentials are logged and never block', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { res, next, logger } = await run(
      androidEnv({ PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: undefined }),
      attestationHeaders('android'),
      fetchImpl,
    );
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'device attestation verdict',
      expect.objectContaining({ outcome: 'unconfigured' }),
    );
  });

  it('enforce: a malformed service account answers 500 configuration_error', async () => {
    const { res } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: 'enforce', PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: '{' }),
      attestationHeaders('android'),
      vi.fn<typeof fetch>(),
    );
    expect(res?.status).toBe(500);
    expect(await readJson<{ code: string }>(res as Response)).toMatchObject({
      code: 'configuration_error',
    });
  });
});

describe('deviceAttestation middleware — malformed input', () => {
  it.each([
    [
      { [DEVICE_ATTESTATION_PLATFORM_HEADER]: 'windows', [DEVICE_ATTESTATION_TOKEN_HEADER]: 't' },
      'platform_invalid',
    ],
    [{ [DEVICE_ATTESTATION_PLATFORM_HEADER]: 'android' }, 'token_missing'],
    [
      {
        [DEVICE_ATTESTATION_PLATFORM_HEADER]: 'android',
        [DEVICE_ATTESTATION_TOKEN_HEADER]: 'x'.repeat(16_385),
      },
      'token_too_long',
    ],
  ])('enforce rejects %j with %s and calls no provider', async (headers, reason) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { res, logger } = await run(
      androidEnv({ DEVICE_ATTESTATION_MODE: 'enforce' }),
      { 'cf-turnstile-token': TURNSTILE_TOKEN, ...headers },
      fetchImpl,
    );
    expect(res?.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(verdictLog(logger)).toMatchObject({ reasons: [reason] });
  });
});

describe('deviceAttestation middleware — iOS (DeviceCheck)', () => {
  it('report: validates the device token with an ES256 provider JWT', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 200 })));
    const { res, next, logger } = await run(
      iosEnv(),
      attestationHeaders('ios', 'dc-token'),
      fetchImpl,
    );

    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'pass',
      platform: 'ios',
      requestBound: false,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(APPLE_DEVICECHECK_URLS.production);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ device_token: 'dc-token', timestamp: NOW });
    expect(typeof body['transaction_id']).toBe('string');
    const jwt = (new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '');
    const [header, claims] = jwt
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as unknown);
    expect(header).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
    expect(claims).toEqual({ iss: 'TEAM123456', iat: Math.floor(NOW / 1000) });
  });

  it('uses the development endpoint when configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 200 })));
    await run(
      iosEnv({ APPLE_DEVICECHECK_ENVIRONMENT: 'development' }),
      attestationHeaders('ios'),
      fetchImpl,
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(APPLE_DEVICECHECK_URLS.development);
  });

  it('enforce: answers 403 when Apple rejects the device token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('bad', { status: 400 })),
    );
    const { res } = await run(
      iosEnv({ DEVICE_ATTESTATION_MODE: 'enforce' }),
      attestationHeaders('ios'),
      fetchImpl,
    );
    expect(res?.status).toBe(403);
  });

  it('report: fails open when Apple is down', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 500 })));
    const { res, next, logger } = await run(iosEnv(), attestationHeaders('ios'), fetchImpl);
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(verdictLog(logger)).toMatchObject({ outcome: 'unavailable', upstreamStatus: 500 });
  });

  it('report: the timeout also bounds a stalled DeviceCheck body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(stalledBodyResponse()));
    const { res, next, logger } = await run(iosEnv(), attestationHeaders('ios'), fetchImpl, {
      timeoutMs: 50,
    });
    expect(res).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(verdictLog(logger)).toMatchObject({
      outcome: 'unavailable',
      reasons: ['provider_timeout'],
    });
  });

  it('enforce: an invalid private key answers 500 configuration_error', async () => {
    const { res } = await run(
      iosEnv({ DEVICE_ATTESTATION_MODE: 'enforce', APPLE_DEVICECHECK_PRIVATE_KEY: 'not-a-key' }),
      attestationHeaders('ios'),
      vi.fn<typeof fetch>(),
    );
    expect(res?.status).toBe(500);
  });
});
