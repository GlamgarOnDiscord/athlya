/**
 * Device attestation signal on mobile sign-in and registration (issue #659).
 *
 * Turnstile (`middleware/turnstile.ts`) proves that a browser engine
 * solved a challenge. Platform attestation adds a second, independent
 * signal: the request comes from a genuine Athlya build on a real
 * device. It never replaces Turnstile; this middleware is mounted
 * AFTER `turnstile()` on `POST /v1/auth/login` and
 * `POST /v1/auth/register`.
 *
 * ### Mode (`DEVICE_ATTESTATION_MODE`)
 *
 *   • unset / `off` / any unknown value — the middleware calls
 *     `next()` and makes no outbound call. This is the default, so
 *     shipping this module changes nothing.
 *   • `report` — verifies a presented attestation, logs the verdict
 *     and always calls `next()`. Provider outages, missing
 *     credentials and failed verdicts never block a sign-in.
 *   • `enforce` — a presented attestation that fails verification is
 *     answered `403 device_attestation_failed`; a provider outage
 *     `503 device_attestation_unavailable`; missing credentials
 *     `500 configuration_error`.
 *
 * In every mode a request WITHOUT attestation headers goes through
 * unchanged: the web client and older app builds send none, and the
 * server cannot yet tell them apart from a client that strips them.
 * `enforce` therefore only rejects attestations that were presented
 * and failed.
 *
 * ### Contract
 *
 * The app sends two headers next to `cf-turnstile-token`:
 *
 *   • `x-device-attestation-platform`: `android` | `ios`
 *   • `x-device-attestation-token`: the Play Integrity token
 *     (Android) or the DeviceCheck device token (iOS)
 *
 * Android binds its token to the request: the app passes
 * {@link computeAttestationRequestHash}`(action, turnstileToken)` as
 * the Play Integrity `requestHash`. Turnstile tokens are single-use
 * and verified by siteverify before this middleware runs, so a
 * replayed integrity token carries a hash that matches no fresh
 * Turnstile token. Apple DeviceCheck tokens cannot carry request
 * data; their verdict proves a genuine Apple device running an app of
 * the team, but is not bound to the request (logged as
 * `requestBound: false`). App Attest assertions, which are bound,
 * need per-device key storage and are a follow-up.
 *
 * Tokens and request hashes are never logged.
 */

import type { AthlyaEnvironment } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Header carrying the attesting platform. */
export const DEVICE_ATTESTATION_PLATFORM_HEADER = 'x-device-attestation-platform';

/** Header carrying the platform attestation token. */
export const DEVICE_ATTESTATION_TOKEN_HEADER = 'x-device-attestation-token';

/** Prefix of the string hashed into the Play Integrity `requestHash`. */
export const ATTESTATION_REQUEST_HASH_PREFIX = 'athlya-auth-v1';

/** Google OAuth 2.0 token endpoint (pinned: never read from the service account JSON). */
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** OAuth scope of the Play Integrity API. */
export const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';

/** Base URL of the Play Integrity API. */
export const PLAY_INTEGRITY_API_BASE = 'https://playintegrity.googleapis.com/v1';

/** Apple DeviceCheck `validate_device_token` endpoints. */
export const APPLE_DEVICECHECK_URLS = {
  production: 'https://api.devicecheck.apple.com/v1/validate_device_token',
  development: 'https://api.development.devicecheck.apple.com/v1/validate_device_token',
} as const;

/** Android application id; `PLAY_INTEGRITY_PACKAGE_NAME` overrides it. */
export const DEFAULT_ANDROID_PACKAGE_NAME = 'app.athlya.mobile';

/** Largest token accepted in the header. Play Integrity tokens are a few KB. */
export const MAX_ATTESTATION_TOKEN_LENGTH = 16_384;

/** Oldest accepted Play Integrity token (`requestDetails.timestampMillis`). */
export const DEFAULT_MAX_TOKEN_AGE_MS = 5 * 60_000;

/** Tolerated device clock lead over the Worker clock. */
export const DEFAULT_CLOCK_SKEW_MS = 60_000;

/** Timeout of each outbound provider call. */
const DEFAULT_TIMEOUT_MS = 3_000;

/** Lifetime requested for the Google OAuth assertion. */
const GOOGLE_ASSERTION_TTL_SEC = 3_600;

/** Apple accepts provider JWTs up to one hour old; refresh well before. */
const APPLE_JWT_REUSE_MS = 20 * 60_000;

/** Margin before expiry at which a cached Google access token is renewed. */
const TOKEN_RENEW_MARGIN_MS = 60_000;

const PROBLEM_JSON = 'application/problem+json';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type DeviceAttestationMode = 'off' | 'report' | 'enforce';

export type DeviceAttestationPlatform = 'android' | 'ios';

/** Route the attestation was presented on; part of the request hash. */
export type DeviceAttestationAction = 'login' | 'register';

/**
 * Verification outcome.
 *
 *   • `pass` — every check succeeded.
 *   • `fail` — the token was rejected or a check failed.
 *   • `unavailable` — the provider could not be reached or errored.
 *   • `unconfigured` — the Worker lacks credentials for the platform.
 */
export type AttestationOutcome = 'pass' | 'fail' | 'unavailable' | 'unconfigured';

export interface AttestationVerdict {
  readonly outcome: AttestationOutcome;
  /** Machine-readable reasons for a non-`pass` outcome. Empty on `pass`. */
  readonly reasons: readonly string[];
  /** Non-sensitive verdict fields worth logging. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DeviceAttestationLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Worker bindings read by the middleware. */
export interface DeviceAttestationEnv {
  readonly ENVIRONMENT: AthlyaEnvironment;
  readonly DEVICE_ATTESTATION_MODE?: string;
  readonly PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON?: string;
  readonly PLAY_INTEGRITY_PACKAGE_NAME?: string;
  readonly APPLE_DEVICECHECK_TEAM_ID?: string;
  readonly APPLE_DEVICECHECK_KEY_ID?: string;
  readonly APPLE_DEVICECHECK_PRIVATE_KEY?: string;
  readonly APPLE_DEVICECHECK_ENVIRONMENT?: string;
}

/** Framework-free context; Hono's `Context<HonoEnv>` satisfies it structurally. */
export interface DeviceAttestationContext {
  readonly env: DeviceAttestationEnv;
  readonly req: { header(name: string): string | undefined };
  get(key: 'traceId'): unknown;
  get(key: 'logger'): unknown;
  body(data: string, status: number, headers: Record<string, string>): Response;
}

export type DeviceAttestationMiddleware = (
  c: DeviceAttestationContext,
  next: () => Promise<void>,
) => Promise<Response | void>;

/** Shared knobs of the provider verifiers. */
export interface VerifierRuntime {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly timeoutMs: number;
}

interface CachedCredential {
  readonly value: string;
  readonly expiresAt: number;
}

/** Per-isolate credential cache: Google access tokens and Apple provider JWTs. */
export type CredentialCache = Map<string, CachedCredential>;

const defaultCredentialCache: CredentialCache = new Map();

export interface DeviceAttestationOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxTokenAgeMs?: number;
  readonly clockSkewMs?: number;
  /** Defaults to a module-level cache shared by every instance in the isolate. */
  readonly credentialCache?: CredentialCache;
}

/* ------------------------------------------------------------------ */
/*  Mode and request hash                                              */
/* ------------------------------------------------------------------ */

/** Parse `DEVICE_ATTESTATION_MODE`. Unknown values fall back to `off`. */
export function resolveDeviceAttestationMode(raw: string | undefined): DeviceAttestationMode {
  const value = raw?.trim().toLowerCase();
  return value === 'report' || value === 'enforce' ? value : 'off';
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(new TextEncoder().encode(value));
}

/**
 * Value the app passes as the Play Integrity `requestHash`:
 * base64url (no padding) of SHA-256(`athlya-auth-v1:<action>:<turnstile token>`).
 * 43 characters, below the API's 500-character limit.
 */
export async function computeAttestationRequestHash(
  action: DeviceAttestationAction,
  turnstileToken: string,
): Promise<string> {
  const input = `${ATTESTATION_REQUEST_HASH_PREFIX}:${action}:${turnstileToken.trim()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  algorithm: AlgorithmIdentifier | EcdsaParams,
): Promise<string> {
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
    JSON.stringify(claims),
  )}`;
  const signature = await crypto.subtle.sign(
    algorithm,
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

class ProviderError extends Error {
  constructor(
    readonly reason: string,
    readonly upstreamStatus?: number,
  ) {
    super(reason);
    this.name = 'ProviderError';
  }
}

/** Status and fully read body of a provider call. */
interface ProviderResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

/**
 * One provider call, bounded end to end: the timeout covers the
 * response headers AND the body read, so a provider that stalls while
 * streaming the body cannot hold the sign-in past `timeoutMs`.
 */
async function fetchWithTimeout(
  runtime: VerifierRuntime,
  url: string,
  init: RequestInit,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      controller.abort();
      reject(new ProviderError('provider_timeout'));
    }, runtime.timeoutMs);
  });
  const call = (async (): Promise<ProviderResponse> => {
    const res = await runtime.fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  })();
  // The losing branch of the race still settles; keep its rejection handled.
  call.catch(() => undefined);
  try {
    return await Promise.race([call, deadline]);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const name = err instanceof Error ? err.name : '';
    throw new ProviderError(name === 'AbortError' ? 'provider_timeout' : 'provider_network_error');
  } finally {
    clearTimeout(handle);
  }
}

function parseProviderJson<T>(text: string, malformedReason: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(malformedReason);
  }
}

function unavailable(reason: string, details?: Record<string, unknown>): AttestationVerdict {
  return { outcome: 'unavailable', reasons: [reason], ...(details ? { details } : {}) };
}

function unconfigured(reason: string): AttestationVerdict {
  return { outcome: 'unconfigured', reasons: [reason] };
}

function fromProviderError(err: unknown): AttestationVerdict {
  if (err instanceof ProviderError) {
    return unavailable(
      err.reason,
      err.upstreamStatus !== undefined ? { upstreamStatus: err.upstreamStatus } : undefined,
    );
  }
  return unavailable('verifier_error');
}

/* ------------------------------------------------------------------ */
/*  Android — Play Integrity                                           */
/* ------------------------------------------------------------------ */

export interface PlayIntegrityConfig {
  /** Google Cloud service account key (JSON) allowed to call the Play Integrity API. */
  readonly serviceAccountJson: string;
  readonly packageName: string;
}

interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
}

function parseServiceAccount(json: string): ServiceAccount | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    const clientEmail = record['client_email'];
    const privateKey = record['private_key'];
    if (typeof clientEmail !== 'string' || clientEmail.length === 0) return undefined;
    if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) return undefined;
    return { clientEmail, privateKey };
  } catch {
    return undefined;
  }
}

async function googleAccessToken(
  account: ServiceAccount,
  runtime: VerifierRuntime,
  cache: CredentialCache,
): Promise<string> {
  const cacheKey = `google:${account.clientEmail}`;
  const cached = cache.get(cacheKey);
  const nowMs = runtime.now();
  if (cached !== undefined && cached.expiresAt - TOKEN_RENEW_MARGIN_MS > nowMs) {
    return cached.value;
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(account.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const iat = Math.floor(nowMs / 1000);
  const assertion = await signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: account.clientEmail,
      scope: PLAY_INTEGRITY_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp: iat + GOOGLE_ASSERTION_TTL_SEC,
    },
    key,
    { name: 'RSASSA-PKCS1-v1_5' },
  );

  const form = new URLSearchParams();
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  form.set('assertion', assertion);
  const res = await fetchWithTimeout(runtime, GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new ProviderError('google_oauth_rejected', res.status);
  }
  const payload = parseProviderJson<{ access_token?: unknown; expires_in?: unknown } | null>(
    res.text,
    'google_oauth_malformed',
  );
  if (
    payload === null ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0
  ) {
    throw new ProviderError('google_oauth_malformed');
  }
  const expiresInSec = typeof payload.expires_in === 'number' ? payload.expires_in : 3_600;
  cache.set(cacheKey, {
    value: payload.access_token,
    expiresAt: nowMs + expiresInSec * 1000,
  });
  return payload.access_token;
}

interface PlayIntegrityPayload {
  readonly requestDetails?: {
    readonly requestPackageName?: string;
    readonly requestHash?: string;
    readonly timestampMillis?: string | number;
  };
  readonly appIntegrity?: {
    readonly appRecognitionVerdict?: string;
    readonly packageName?: string;
  };
  readonly deviceIntegrity?: {
    readonly deviceRecognitionVerdict?: readonly string[];
  };
  readonly accountDetails?: {
    readonly appLicensingVerdict?: string;
  };
}

/** Pure check of a decoded Play Integrity payload. Exported for tests. */
export function evaluatePlayIntegrityPayload(
  payload: PlayIntegrityPayload,
  expected: {
    readonly packageName: string;
    readonly requestHash: string;
    readonly nowMs: number;
    readonly maxTokenAgeMs: number;
    readonly clockSkewMs: number;
  },
): AttestationVerdict {
  const reasons: string[] = [];
  const request = payload.requestDetails;

  if (request?.requestPackageName !== expected.packageName) reasons.push('package_mismatch');
  if (request?.requestHash !== expected.requestHash) reasons.push('request_hash_mismatch');

  const timestamp = Number(request?.timestampMillis);
  if (!Number.isFinite(timestamp)) {
    reasons.push('timestamp_missing');
  } else if (timestamp > expected.nowMs + expected.clockSkewMs) {
    reasons.push('timestamp_in_future');
  } else if (expected.nowMs - timestamp > expected.maxTokenAgeMs) {
    reasons.push('token_stale');
  }

  const appVerdict = payload.appIntegrity?.appRecognitionVerdict;
  if (appVerdict !== 'PLAY_RECOGNIZED') reasons.push('app_not_recognized');
  const appPackage = payload.appIntegrity?.packageName;
  if (appPackage !== undefined && appPackage !== expected.packageName) {
    reasons.push('app_package_mismatch');
  }

  const deviceVerdict = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!deviceVerdict.includes('MEETS_DEVICE_INTEGRITY')) reasons.push('device_integrity');

  return {
    outcome: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    details: {
      requestBound: true,
      appRecognitionVerdict: appVerdict ?? null,
      deviceRecognitionVerdict: deviceVerdict,
      appLicensingVerdict: payload.accountDetails?.appLicensingVerdict ?? null,
    },
  };
}

export async function verifyPlayIntegrity(
  config: PlayIntegrityConfig,
  token: string,
  requestHash: string,
  runtime: VerifierRuntime,
  options: {
    readonly cache: CredentialCache;
    readonly maxTokenAgeMs: number;
    readonly clockSkewMs: number;
  },
): Promise<AttestationVerdict> {
  const account = parseServiceAccount(config.serviceAccountJson);
  if (account === undefined) return unconfigured('play_integrity_service_account_invalid');

  try {
    let accessToken: string;
    try {
      accessToken = await googleAccessToken(account, runtime, options.cache);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      return unconfigured('play_integrity_private_key_invalid');
    }

    const url = `${PLAY_INTEGRITY_API_BASE}/${encodeURIComponent(config.packageName)}:decodeIntegrityToken`;
    const res = await fetchWithTimeout(runtime, url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ integrity_token: token }),
    });

    if (res.status === 400) {
      return { outcome: 'fail', reasons: ['token_rejected'], details: { requestBound: true } };
    }
    if (res.status === 401) {
      options.cache.delete(`google:${account.clientEmail}`);
    }
    if (!res.ok) {
      return unavailable('play_integrity_error', { upstreamStatus: res.status });
    }

    const body = parseProviderJson<{ tokenPayloadExternal?: PlayIntegrityPayload } | null>(
      res.text,
      'play_integrity_malformed',
    );
    if (body?.tokenPayloadExternal === undefined) {
      return unavailable('play_integrity_malformed');
    }
    return evaluatePlayIntegrityPayload(body.tokenPayloadExternal, {
      packageName: config.packageName,
      requestHash,
      nowMs: runtime.now(),
      maxTokenAgeMs: options.maxTokenAgeMs,
      clockSkewMs: options.clockSkewMs,
    });
  } catch (err) {
    return fromProviderError(err);
  }
}

/* ------------------------------------------------------------------ */
/*  iOS — Apple DeviceCheck                                            */
/* ------------------------------------------------------------------ */

export interface AppleDeviceCheckConfig {
  readonly teamId: string;
  readonly keyId: string;
  /** PKCS#8 PEM of the `.p8` key with the DeviceCheck capability. */
  readonly privateKey: string;
  readonly environment: 'production' | 'development';
}

async function appleProviderJwt(
  config: AppleDeviceCheckConfig,
  runtime: VerifierRuntime,
  cache: CredentialCache,
): Promise<string> {
  const cacheKey = `apple:${config.teamId}:${config.keyId}`;
  const nowMs = runtime.now();
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > nowMs) return cached.value;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(config.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const jwt = await signJwt(
    { alg: 'ES256', kid: config.keyId, typ: 'JWT' },
    { iss: config.teamId, iat: Math.floor(nowMs / 1000) },
    key,
    { name: 'ECDSA', hash: 'SHA-256' },
  );
  cache.set(cacheKey, { value: jwt, expiresAt: nowMs + APPLE_JWT_REUSE_MS });
  return jwt;
}

export async function verifyAppleDeviceCheck(
  config: AppleDeviceCheckConfig,
  token: string,
  runtime: VerifierRuntime,
  options: { readonly cache: CredentialCache },
): Promise<AttestationVerdict> {
  let jwt: string;
  try {
    jwt = await appleProviderJwt(config, runtime, options.cache);
  } catch {
    return unconfigured('devicecheck_private_key_invalid');
  }

  try {
    const res = await fetchWithTimeout(runtime, APPLE_DEVICECHECK_URLS[config.environment], {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        device_token: token,
        transaction_id: crypto.randomUUID(),
        timestamp: runtime.now(),
      }),
    });

    if (res.status === 200) {
      return { outcome: 'pass', reasons: [], details: { requestBound: false } };
    }
    if (res.status === 400) {
      return { outcome: 'fail', reasons: ['token_rejected'], details: { requestBound: false } };
    }
    if (res.status === 401 || res.status === 403) {
      options.cache.delete(`apple:${config.teamId}:${config.keyId}`);
    }
    return unavailable('devicecheck_error', { upstreamStatus: res.status });
  } catch (err) {
    return fromProviderError(err);
  }
}

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

function readTraceId(c: DeviceAttestationContext): string {
  const raw = c.get('traceId');
  return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
}

function readLogger(c: DeviceAttestationContext): DeviceAttestationLogger {
  const raw = c.get('logger');
  if (raw !== null && typeof raw === 'object' && 'info' in raw && 'warn' in raw && 'error' in raw) {
    return raw as DeviceAttestationLogger;
  }
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function problem(
  c: DeviceAttestationContext,
  status: number,
  title: string,
  code: string,
): Response {
  return c.body(
    JSON.stringify({ type: 'about:blank', title, status, traceId: readTraceId(c), code }),
    status,
    { 'content-type': PROBLEM_JSON },
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function playIntegrityConfig(env: DeviceAttestationEnv): PlayIntegrityConfig | undefined {
  const serviceAccountJson = nonEmpty(env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON);
  if (serviceAccountJson === undefined) return undefined;
  return {
    serviceAccountJson,
    packageName: nonEmpty(env.PLAY_INTEGRITY_PACKAGE_NAME) ?? DEFAULT_ANDROID_PACKAGE_NAME,
  };
}

function appleDeviceCheckConfig(env: DeviceAttestationEnv): AppleDeviceCheckConfig | undefined {
  const teamId = nonEmpty(env.APPLE_DEVICECHECK_TEAM_ID);
  const keyId = nonEmpty(env.APPLE_DEVICECHECK_KEY_ID);
  const privateKey = nonEmpty(env.APPLE_DEVICECHECK_PRIVATE_KEY);
  if (teamId === undefined || keyId === undefined || privateKey === undefined) return undefined;
  const environment =
    nonEmpty(env.APPLE_DEVICECHECK_ENVIRONMENT)?.toLowerCase() === 'development'
      ? 'development'
      : 'production';
  return { teamId, keyId, privateKey, environment };
}

/**
 * Build the device attestation middleware for one route.
 *
 * Mount it after `turnstile()`: the Android request hash is derived
 * from the `cf-turnstile-token` header that `turnstile()` has already
 * verified.
 */
export function deviceAttestation(
  action: DeviceAttestationAction,
  options: DeviceAttestationOptions = {},
): DeviceAttestationMiddleware {
  const runtime: VerifierRuntime = {
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now: options.now ?? (() => Date.now()),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const cache = options.credentialCache ?? defaultCredentialCache;
  const maxTokenAgeMs = options.maxTokenAgeMs ?? DEFAULT_MAX_TOKEN_AGE_MS;
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  return async (c, next) => {
    const mode = resolveDeviceAttestationMode(c.env.DEVICE_ATTESTATION_MODE);
    if (mode === 'off') {
      await next();
      return;
    }

    const logger = readLogger(c);
    const traceId = readTraceId(c);
    const rawPlatform = nonEmpty(c.req.header(DEVICE_ATTESTATION_PLATFORM_HEADER));
    const token = nonEmpty(c.req.header(DEVICE_ATTESTATION_TOKEN_HEADER));

    if (rawPlatform === undefined && token === undefined) {
      logger.info('device attestation absent', { traceId, mode, action });
      await next();
      return;
    }

    const platform = rawPlatform?.toLowerCase();
    let verdict: AttestationVerdict;
    if (platform !== 'android' && platform !== 'ios') {
      verdict = { outcome: 'fail', reasons: ['platform_invalid'] };
    } else if (token === undefined) {
      verdict = { outcome: 'fail', reasons: ['token_missing'] };
    } else if (token.length > MAX_ATTESTATION_TOKEN_LENGTH) {
      verdict = { outcome: 'fail', reasons: ['token_too_long'] };
    } else if (platform === 'android') {
      const config = playIntegrityConfig(c.env);
      const turnstileToken = nonEmpty(c.req.header('cf-turnstile-token'));
      if (config === undefined) {
        verdict = unconfigured('play_integrity_not_configured');
      } else if (turnstileToken === undefined) {
        verdict = { outcome: 'fail', reasons: ['turnstile_token_missing'] };
      } else {
        const requestHash = await computeAttestationRequestHash(action, turnstileToken);
        verdict = await verifyPlayIntegrity(config, token, requestHash, runtime, {
          cache,
          maxTokenAgeMs,
          clockSkewMs,
        });
      }
    } else {
      const config = appleDeviceCheckConfig(c.env);
      verdict =
        config === undefined
          ? unconfigured('devicecheck_not_configured')
          : await verifyAppleDeviceCheck(config, token, runtime, { cache });
    }

    const fields = {
      traceId,
      mode,
      action,
      platform: platform === 'android' || platform === 'ios' ? platform : 'invalid',
      outcome: verdict.outcome,
      reasons: verdict.reasons,
      ...(verdict.details ?? {}),
    };
    if (verdict.outcome === 'pass') {
      logger.info('device attestation verdict', fields);
    } else if (verdict.outcome === 'unconfigured') {
      logger.error('device attestation verdict', fields);
    } else {
      logger.warn('device attestation verdict', fields);
    }

    if (mode === 'enforce') {
      if (verdict.outcome === 'fail') {
        return problem(c, 403, 'Forbidden', 'device_attestation_failed');
      }
      if (verdict.outcome === 'unavailable') {
        return problem(c, 503, 'Service Unavailable', 'device_attestation_unavailable');
      }
      if (verdict.outcome === 'unconfigured') {
        return problem(c, 500, 'Internal Server Error', 'configuration_error');
      }
    }

    await next();
    return;
  };
}
